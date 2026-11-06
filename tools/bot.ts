/**
 * Test bot: joins a room by code and plays like a so-so player.
 *   npx tsx tools/bot.ts ROOM [name] [server]
 */
import WebSocket from "ws";
import type { ClientMsg, RoomView, ServerMsg } from "../packages/protocol/src/index.ts";

const [code, name = "Бот Вася", server = "http://localhost:8787"] = process.argv.slice(2);
if (!code) {
  console.log("Использование: npx tsx tools/bot.ts КОД_КОМНАТЫ [имя] [адрес сервера]");
  process.exit(1);
}
const ws = new WebSocket(server.replace(/^http/, "ws") + "/ws");
const send = (m: ClientMsg) => ws.send(JSON.stringify(m));
const later = (ms: number, f: () => void) => setTimeout(f, ms);
let acted = "";

ws.on("open", () => {
  send({ t: "hello", token: "bot-" + name + "-0000000000000000", name });
  send({ t: "joinRoom", roomId: code });
});
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw)) as ServerMsg;
  if (m.t === "error") console.log("ошибка:", m.message);
  // A bot needs no files: it says at once that it has the round's media.
  if (m.t === "preload") return send({ t: "preloaded", round: m.round });
  if (m.t !== "room") return;
  const r: RoomView = m.room;
  const meId = r.me.id;
  const me = r.players.find((p) => p.id === meId);
  const key = `${r.phase}:${r.question?.stage}:${r.question?.index}:${r.question?.themeIndex}:${r.stake?.turnId}:${r.secret?.recipientId}:${r.final?.turnId}:${r.chooserId}`;
  if (key === acted) return;
  if (r.phase === "lobby" && me && !me.ready) { acted = key; later(500, () => send({ t: "ready", value: true })); }
  if (r.phase === "choosing" && r.chooserId === meId && r.board) {
    acted = key;
    const open = r.board.themes.flatMap((t, ti) => t.prices.map((p, qi) => (p == null ? null : [ti, qi]))).filter(Boolean) as number[][];
    const [ti, qi] = open[Math.floor(Math.random() * open.length)];
    later(1500, () => send({ t: "choose", theme: ti, index: qi }));
  }
  const q = r.question;
  // Bots have no browser to load media in: report ready at once.
  if (r.phase === "question" && q?.loading) send({ t: "mediaReady", key: `${q.themeIndex}:${q.index}` });
  if (r.phase === "question" && q?.kind === "forAll") {
    if (q.stage === "open" && !q.forAll?.done.includes(meId)) { acted = key; later(2500, () => send({ t: "submit", text: Math.random() < 0.5 ? "Москва" : "не знаю" })); }
    return;
  }
  if (r.phase === "question" && q?.stage === "open" && !q.wrongIds.includes(meId) && Math.random() < 0.6) { acted = key; later(600 + Math.random() * 2500, () => send({ t: "buzz" })); }
  if (r.phase === "question" && q?.stage === "answering" && q.answeringId === meId && !q.submitted) {
    acted = key;
    later(1500, () => send({ t: "submit", text: Math.random() < 0.5 ? "не знаю" : "Олимп" }));
  }
  if (r.phase === "stake" && r.stake?.turnId === meId) { acted = key; later(1000, () => send({ t: "bid", kind: r.stake!.leaderId ? "pass" : "bid", value: r.stake!.minBid })); }
  if (r.phase === "secret" && r.secret?.giverId === meId && !r.secret.recipientId) { acted = key; later(1000, () => send({ t: "giveSecret", to: r.secret!.candidates[0] })); }
  if (r.phase === "secret" && r.secret?.recipientId === meId && r.secret.priceChoice) { acted = key; later(1000, () => send({ t: "secretPrice", value: r.secret!.priceChoice!.min })); }
  if (r.phase === "finalThemes" && r.final?.turnId === meId) { acted = key; later(1000, () => send({ t: "removeTheme", index: r.final!.themes.findIndex((t) => !t.removed) })); }
  if (r.phase === "finalStakes" && r.final?.participants.includes(meId) && r.final.myStake == null) { acted = key; later(1000, () => send({ t: "finalStake", value: 1 })); }
  if (r.phase === "finalAnswer" && r.final?.participants.includes(meId) && !r.final.answersDone.includes(meId)) { acted = key; later(2000, () => send({ t: "submit", text: "Волга" })); }
});
ws.on("close", () => process.exit(0));
console.log(`${name} подключается к комнате ${code}`);
