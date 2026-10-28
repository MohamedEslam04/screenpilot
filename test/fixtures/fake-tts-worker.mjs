// Speaks the python/tts_worker.py protocol with silent WAV files, so tests need no models.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

function silentWav(seconds) {
  const sr = 24000;
  const data = Buffer.alloc(Math.round(sr * seconds) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (process.env.FAKE_WORKER_CRASH_ON_START) {
  console.error("boom: model library missing");
  process.exit(3);
}
send({ ready: true, protocol: 1 });

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    send({ id: null, ok: false, kind: "other", error: "bad json" });
    return;
  }
  if (m.cmd === "quit") {
    send({ id: m.id, ok: true });
    process.exit(0);
  } else if (m.cmd === "voices") {
    send({
      id: m.id,
      ok: true,
      models: [
        { name: "voicetut", langs: ["ar", "en"], voices: ["Ahmed", "Sarah"], installed: true },
        { name: "namaa", langs: ["ar"], voices: ["default"], installed: false },
      ],
    });
  } else if (m.cmd === "synth") {
    if (m.voice === "Nobody") return send({ id: m.id, ok: false, kind: "bad-voice", error: "No voice Nobody. Valid: Ahmed, Sarah" });
    mkdirSync(dirname(m.out), { recursive: true });
    writeFileSync(m.out, silentWav(0.2));
    send({ id: m.id, ok: true, duration: 0.2, sr: 24000, echo: { model: m.model, voice: m.voice, speed: m.speed, text: m.text } });
  } else {
    send({ id: m.id, ok: false, kind: "other", error: "unknown cmd" });
  }
});
