import express from "express";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.PGP_BACKEND_DATA_DIR ?? path.join(__dirname, "data");
const dataFile = path.join(dataDir, "keys.json");
const port = Number(process.env.PORT ?? 8787);

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use((_, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
});
app.options(/.*/, (_, res) => res.sendStatus(204));

async function readKeys() {
    try {
        return JSON.parse(await readFile(dataFile, "utf8"));
    } catch (e) {
        if (e?.code === "ENOENT") return {};
        throw e;
    }
}

async function writeKeys(keys) {
    await mkdir(dataDir, { recursive: true });
    const tmpFile = `${dataFile}.${process.pid}.tmp`;
    await writeFile(tmpFile, `${JSON.stringify(keys, null, 4)}\n`);
    await rename(tmpFile, dataFile);
}

function isDiscordId(value) {
    return typeof value === "string" && /^\d{5,25}$/.test(value);
}

function isPublicKey(value) {
    return typeof value === "string"
        && value.length <= 128_000
        && value.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----")
        && value.includes("-----END PGP PUBLIC KEY BLOCK-----");
}

app.get("/api/health", (_, res) => {
    res.json({ ok: true });
});

app.get("/keys/:discordId", async (req, res, next) => {
    try {
        const { discordId } = req.params;
        if (!isDiscordId(discordId)) return res.status(400).json({ error: "Invalid Discord ID" });

        const keys = await readKeys();
        const publicKey = keys[discordId] ?? null;
        if (!publicKey) return res.sendStatus(404);

        res.json({ discordId, publicKey });
    } catch (e) {
        next(e);
    }
});

app.post("/keys/bulk", async (req, res, next) => {
    try {
        const discordIds = Array.isArray(req.body?.discordIds) ? req.body.discordIds : [];
        if (discordIds.length > 100 || discordIds.some(id => !isDiscordId(id))) {
            return res.status(400).json({ error: "Invalid Discord IDs" });
        }

        const keys = await readKeys();
        res.json({
            keys: Object.fromEntries(discordIds.map(id => [id, keys[id] ?? null]))
        });
    } catch (e) {
        next(e);
    }
});

app.post("/keys", async (req, res, next) => {
    try {
        const { discordId, publicKey } = req.body ?? {};
        if (!isDiscordId(discordId)) return res.status(400).json({ error: "Invalid Discord ID" });
        if (!isPublicKey(publicKey)) return res.status(400).json({ error: "Invalid PGP public key" });

        const keys = await readKeys();
        keys[discordId] = publicKey;
        await writeKeys(keys);

        res.status(201).json({ discordId, publicKey });
    } catch (e) {
        next(e);
    }
});

app.use((err, _, res, __) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(port, "127.0.0.1", error => {
    if (error) {
        console.error(error);
        process.exitCode = 1;
        return;
    }

    console.log(`Vencord PGP backend listening on http://127.0.0.1:${port}`);
});

server.on("error", error => {
    console.error(error);
    process.exitCode = 1;
});
