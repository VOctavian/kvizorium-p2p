import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { formatText, type ChatItem, type ClientMsg, type RoomSummary, type RoomView, type ServerMsg } from "@kvz/protocol";
import { startServer } from "../src/index.ts";
import { IDLE_MS, LOBBY_MS, NO_SEATS_MS, OFFLINE_GAME_MS, OFFLINE_LOBBY_MS, OVER_MS, Room, WARN_MS } from "@kvz/game";

let srv: Awaited<ReturnType<typeof startServer>>;
before(async () => {
  srv = await startServer({ port: 0, packsDir: join(import.meta.dirname, "..", "..", "..", "packs"), dataDir: mkdtempSync(join(tmpdir(), "kvz-test-")), log: () => {} });
});
after(() => srv.close());

class Client {
  ws: WebSocket;
  room?: RoomView;
  errors: string[] = [];
  private waiters: { pred: (r: RoomView) => boolean; ok: (r: RoomView) => void }[] = [];
  constructor(public name: string, port = srv.port) {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as ServerMsg;
      if (m.t === "room") {
        this.room = m.room;
        this.waiters = this.waiters.filter((w) => (w.pred(m.room) ? (w.ok(m.room), false) : true));
      }
      if (m.t === "error") this.errors.push(m.message);
    });
  }
  async open() {
    if (this.ws.readyState !== WebSocket.OPEN) await new Promise((ok) => this.ws.once("open", ok));
    this.send({ t: "hello", token: `${this.name}-token-0123456789`, name: this.name });
  }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  until(pred: (r: RoomView) => boolean, ms = 8000): Promise<RoomView> {
    if (this.room && pred(this.room)) return Promise.resolve(this.room);
    return new Promise((ok, fail) => {
      const t = setTimeout(() => fail(new Error(`${this.name}: timeout, phase=${this.room?.phase}`)), ms);
      this.waiters.push({ pred, ok: (r) => { clearTimeout(t); ok(r); } });
    });
  }
  /** Waits for an error message beyond the first `seen` (errors don't come with a room update). */
  async error(seen: number, ms = 3000): Promise<string> {
    const t0 = Date.now();
    while (this.errors.length <= seen) {
      if (Date.now() - t0 > ms) throw new Error(`${this.name}: no error`);
      await new Promise((ok) => setTimeout(ok, 20));
    }
    return this.errors[seen];
  }
  close() { this.ws.close(); }
}

test("auto-host game: choose, buzz, answer, score; host view hides nothing it shouldn't", async () => {
  const a = new Client("Аня");
  const b = new Client("Боря");
  await a.open(); await b.open();
  a.send({ t: "createRoom", name: "Тест", settings: { hostMode: "auto", thinkTime: 5 }, asHost: false });
  const r0 = await a.until((r) => !!r.id);
  b.send({ t: "joinRoom", roomId: r0.id });
  await a.until((r) => r.players.length === 2);
  a.send({ t: "useDemoPack", id: "demo.siq" });
  await a.until((r) => !!r.pack);
  a.send({ t: "start" });
  const choosing = await a.until((r) => r.phase === "choosing", 10000);
  const chooser = choosing.chooserId === choosing.me.id ? a : b;
  const other = chooser === a ? b : a;
  // Theme 0 = "Кино", question 0 = 100 (simple).
  chooser.send({ t: "choose", theme: 0, index: 0 });
  const q = await other.until((r) => r.phase === "question");
  assert.equal(q.question?.price, 100);
  assert.equal(q.question?.answer, undefined, "players must not see the answer before reveal");
  await other.until((r) => r.question?.stage === "open", 15000);
  other.send({ t: "buzz" });
  await other.until((r) => r.question?.answeringId === r.me.id);
  other.send({ t: "submit", text: "валл-и" });
  const after = await other.until((r) => r.question?.stage === "reveal");
  const me = after.players.find((p) => p.id === after.me.id)!;
  assert.equal(me.score, 100);
  assert.deepEqual(after.question?.answer?.text.slice(0, 1), ["ВАЛЛ-И"]);
  const next = await other.until((r) => r.phase === "choosing");
  assert.equal(next.chooserId, next.me.id, "correct answer passes the turn");
  assert.equal(next.board?.themes[0].prices[0], null);
  a.close(); b.close();
});

test("human host sees the answer and judges; wrong answer subtracts", async () => {
  const h = new Client("Ведущий");
  const p = new Client("Игрок");
  await h.open(); await p.open();
  h.send({ t: "createRoom", name: "С ведущим", settings: { hostMode: "human" }, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  assert.equal(r0.me.role, "host");
  p.send({ t: "joinRoom", roomId: r0.id });
  await h.until((r) => r.players.length === 1);
  h.send({ t: "useDemoPack", id: "demo.siq" });
  await h.until((r) => !!r.pack);
  h.send({ t: "start" });
  await p.until((r) => r.phase === "choosing", 10000);
  p.send({ t: "choose", theme: 1, index: 1 });
  const hq = await h.until((r) => r.phase === "question");
  assert.deepEqual(hq.question?.answer?.text, ["Лайка"]);
  h.send({ t: "host", action: "open" });
  await p.until((r) => r.question?.stage === "open");
  p.send({ t: "buzz" });
  await h.until((r) => !!r.question?.answeringId);
  p.send({ t: "submit", text: "Белка" });
  await h.until((r) => r.question?.typed === "Белка" && !!r.question.submitted);
  h.send({ t: "judge", correct: false });
  const res = await p.until((r) => r.question?.stage === "reveal");
  assert.equal(res.players[0].score, -200);
  h.close(); p.close();
});

test("settings: simple game turns an auction into a normal question, no wrong-answer penalty, limits, no viewers", async () => {
  const a = new Client("Настройщик");
  const b = new Client("Второй");
  const c = new Client("Зритель");
  await a.open(); await b.open(); await c.open();
  a.send({ t: "createRoom", name: "Простая", settings: { hostMode: "auto", gameType: "simple", wrongPenalty: false, maxPlayers: 2, allowViewers: false, oral: true, chooseTime: 999, thinkTime: 1 }, asHost: false });
  const r0 = await a.until((r) => !!r.id);
  assert.equal(r0.settings.oral, true, "oral is kept: it applies once someone takes the host's seat");
  assert.equal(r0.settings.chooseTime, 120, "values are clamped");
  assert.equal(r0.settings.thinkTime, 3);
  b.send({ t: "joinRoom", roomId: r0.id });
  await a.until((r) => r.players.length === 2);
  c.send({ t: "joinRoom", roomId: r0.id });
  await new Promise((ok) => setTimeout(ok, 200));
  assert.match(c.errors.join(), /зрители в эту комнату не допускаются/);
  a.send({ t: "settings", settings: { maxPlayers: 1 } });
  assert.equal((await a.until((r) => r.settings.chooseTime === 120)).settings.maxPlayers, 2, "seats can't drop below the players already seated");
  a.send({ t: "useDemoPack", id: "demo.siq" });
  await a.until((r) => !!r.pack);
  a.send({ t: "start" });
  const ch = await a.until((r) => r.phase === "choosing", 10000);
  assert.equal(ch.timer?.kind, "choose");
  const chooser = ch.chooserId === ch.me.id ? a : b;
  chooser.send({ t: "choose", theme: 0, index: 2 }); // "Кино 300" is an auction in the pack
  const q = await chooser.until((r) => r.phase === "question");
  assert.equal(q.question?.kind, "simple");
  await chooser.until((r) => r.question?.stage === "open", 15000);
  chooser.send({ t: "buzz" });
  await chooser.until((r) => r.question?.answeringId === r.me.id);
  chooser.send({ t: "submit", text: "Титаник" });
  const after = await chooser.until((r) => !!r.question?.lastResult);
  assert.equal(after.question?.lastResult?.delta, 0);
  assert.equal(after.players.find((p) => p.id === after.me.id)?.score, 0);
  a.close(); b.close(); c.close();
});

test("question for everyone and answer options (test pack, auto host)", async () => {
  const a = new Client("Первый");
  const b = new Client("Второй");
  await a.open(); await b.open();
  a.send({ t: "createRoom", name: "Все типы", settings: { hostMode: "auto", chooseTime: 0 }, asHost: false });
  const r0 = await a.until((r) => !!r.id);
  b.send({ t: "joinRoom", roomId: r0.id });
  await a.until((r) => r.players.length === 2);
  a.send({ t: "useDemoPack", id: "test-all-types.siq" });
  await a.until((r) => r.pack?.name === "Проверка всех типов вопросов");
  a.send({ t: "start" });
  const ch = await a.until((r) => r.phase === "choosing", 10000);
  const chooser = ch.chooserId === ch.me.id ? a : b;
  const other = chooser === a ? b : a;
  chooser.send({ t: "choose", theme: 2, index: 1 }); // for everyone: "Столица России?"
  await a.until((r) => r.question?.kind === "forAll" && r.question.stage === "open", 15000);
  a.send({ t: "submit", text: "Москва" });
  b.send({ t: "submit", text: "Казань" });
  const rev = await a.until((r) => r.question?.stage === "reveal");
  const byId = Object.fromEntries(rev.question!.forAll!.answers!.map((x) => [x.id, x.delta]));
  assert.equal(byId[a.room!.me.id], 200);
  assert.equal(byId[b.room!.me.id], -200);
  await a.until((r) => r.phase === "choosing");
  const nowChooser = a.room!.chooserId === a.room!.me.id ? a : b;
  nowChooser.send({ t: "choose", theme: 2, index: 3 }); // options: right answer is "B"
  const oq = await nowChooser.until((r) => r.phase === "question" && r.question?.themeIndex === 2 && r.question.index === 3);
  assert.deepEqual(oq.question?.options?.map((o) => o.text), ["Марс", "Юпитер", "Венера", "Земля"]);
  await nowChooser.until((r) => r.question?.stage === "open", 15000);
  nowChooser.send({ t: "buzz" });
  await nowChooser.until((r) => r.question?.answeringId === r.me.id);
  nowChooser.send({ t: "submit", text: "B" });
  const res = await nowChooser.until((r) => !!r.question?.lastResult);
  assert.equal(res.question?.lastResult?.correct, true);
  void other;
  a.close(); b.close();
});

test("host tools: seats, swap roles, edit board, switch round, fix a score from the feed", async () => {
  const h = new Client("Хост");
  const p = new Client("Игрок1");
  const v = new Client("Зритель1");
  await h.open(); await p.open(); await v.open();
  const feed: ChatItem[] = [];
  h.ws.on("message", (raw) => { const m = JSON.parse(String(raw)) as ServerMsg; if (m.t === "chat") for (const it of m.items) { const i = feed.findIndex((x) => x.id === it.id); if (i >= 0) feed[i] = it; else feed.push(it); } });
  h.send({ t: "createRoom", name: "Инструменты", settings: { hostMode: "human", maxPlayers: 1 }, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  p.send({ t: "joinRoom", roomId: r0.id });
  await h.until((r) => r.players.length === 1);
  h.send({ t: "useDemoPack", id: "test-wide.siq" });
  await h.until((r) => !!r.pack);
  h.send({ t: "start" });
  const ch = await h.until((r) => r.phase === "choosing", 10000);
  assert.equal(ch.board?.themes[0].prices.length, 15);
  assert.equal(ch.board?.themes[0].all?.length, 15, "host gets every price for editing");
  assert.equal(p.room?.board?.themes[0].all, undefined, "players don't");

  // Seats: add a table mid-game, a viewer sits down.
  v.send({ t: "joinRoom", roomId: r0.id });
  await h.until((r) => r.viewers.length === 1);
  h.send({ t: "seat", action: "add" });
  await h.until((r) => r.settings.maxPlayers === 2);
  v.send({ t: "becomePlayer" });
  await h.until((r) => r.players.length === 2);

  // Pass the turn to the newcomer, and gender shows up in the room view.
  v.send({ t: "profile", gender: "f" });
  await h.until((r) => r.players.some((x) => x.gender === "f"));
  const vid0 = v.room!.me.id;
  h.send({ t: "setChooser", playerId: vid0 });
  await h.until((r) => r.chooserId === vid0);
  p.send({ t: "setChooser", playerId: p.room!.me.id });
  await new Promise((ok) => setTimeout(ok, 150));
  assert.ok(p.errors.some((e) => /Передать ход может ведущий/.test(e)), "players can't pass the turn");

  // Edit: remove a whole theme and one question, then bring the question back.
  h.send({ t: "edit", theme: 0, remove: true });
  await h.until((r) => r.board!.themes[0].prices.every((x) => x == null));
  h.send({ t: "edit", theme: 0, index: 3, remove: false });
  await h.until((r) => r.board!.themes[0].prices[3] === 400);

  // Switch round: starts from the beginning.
  h.send({ t: "setRound", index: 1 });
  await h.until((r) => r.board?.index === 1 && r.phase === "choosing", 10000);
  h.send({ t: "setRound", index: 0 });
  const back = await h.until((r) => r.board?.index === 0 && r.phase === "choosing", 10000);
  assert.equal(back.board!.themes[0].prices.filter((x) => x != null).length, 15, "round restarts from scratch");

  // Answer wrong, then the host turns it into a right answer from the feed.
  h.send({ t: "choose", theme: 1, index: 0 });
  await h.until((r) => r.phase === "question");
  h.send({ t: "host", action: "open" });
  await p.until((r) => r.question?.stage === "open");
  p.send({ t: "buzz" });
  await h.until((r) => r.question?.answeringId === p.room!.me.id);
  h.send({ t: "judge", correct: false });
  const wrong = await h.until((r) => r.players.find((x) => x.id === p.room!.me.id)?.score === -100);
  void wrong;
  const ev = feed.find((x) => x.fix && x.fix.playerId === p.room!.me.id)!;
  assert.ok(ev, "wrong answer in the feed carries fix data");
  // Feed events travel as message keys; each client renders its own language.
  assert.equal(ev.line?.key, "ev.wrong");
  assert.match(ev.text, /ошибается/, "Russian text stays for bots and logs");
  assert.match(formatText("en", ev.line!), /is wrong · −100$/);
  assert.equal(h.room!.hostLine.key.startsWith("host."), true, "host line is a key");
  h.send({ t: "fixScore", chatId: ev.id, mult: 1 });
  await h.until((r) => r.players.find((x) => x.id === p.room!.me.id)?.score === 100);
  h.send({ t: "fixScore", chatId: ev.id, mult: 2 });
  await h.until((r) => r.players.find((x) => x.id === p.room!.me.id)?.score === 200);
  assert.equal(feed.find((x) => x.id === ev.id)?.fix?.fixed, true);

  // Swap: the player becomes host, the host takes the table and its score.
  const pid = p.room!.me.id;
  h.send({ t: "swapHost", playerId: pid });
  const swapped = await p.until((r) => r.me.role === "host");
  assert.equal(swapped.players.find((x) => x.id === h.room!.me.id)?.score, 200);

  // Remove a table together with its player: only the leader (the creator, now at a table) may.
  const vid = v.room!.me.id;
  p.send({ t: "seat", action: "remove", playerId: vid });
  await p.error(p.errors.length);
  h.send({ t: "seat", action: "remove", playerId: vid });
  const after = await p.until((r) => !r.players.some((x) => x.id === vid));
  assert.equal(after.settings.maxPlayers, 1);
  assert.ok(after.viewers.some((x) => x.id === vid));
  h.close(); p.close(); v.close();
});

test("auction: bids in turn, higher bids win, all-in only beaten by a bigger all-in; cat: only the recipient answers", async () => {
  const h = new Client("ВедущийА");
  const a = new Client("Игрок А");
  const b = new Client("Игрок Б");
  const c = new Client("Игрок В");
  await h.open(); await a.open(); await b.open(); await c.open();
  h.send({ t: "createRoom", name: "Аукцион", settings: { hostMode: "human", chooseTime: 0 }, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  for (const [k, x] of [a, b, c].entries()) { x.send({ t: "joinRoom", roomId: r0.id }); await x.until((r) => r.id === r0.id); await h.until((r) => r.players.length === k + 1); }
  h.send({ t: "useDemoPack", id: "test-all-types.siq" });
  await h.until((r) => !!r.pack);
  h.send({ t: "start" });
  await h.until((r) => r.phase === "choosing", 10000);
  const id = (x: Client) => x.room!.me.id;
  h.send({ t: "setScore", id: id(a), score: 1000 });
  h.send({ t: "setScore", id: id(b), score: 3000 });
  h.send({ t: "setScore", id: id(c), score: 2000 });
  h.send({ t: "setChooser", playerId: id(a) });
  await h.until((r) => r.chooserId === id(a) && r.players.find((p) => p.id === id(b))?.score === 3000);
  a.send({ t: "choose", theme: 1, index: 0 }); // auction, face value 100
  await h.until((r) => r.phase === "stake" && r.stake?.turnId === id(a));
  a.send({ t: "bid", kind: "bid", value: 200 });
  await h.until((r) => r.stake?.turnId === id(b));
  b.send({ t: "bid", kind: "bid", value: 150 });
  await new Promise((ok) => setTimeout(ok, 150));
  assert.ok(b.errors.some((e) => /300|от/.test(e)), "a lower bid is refused");
  b.send({ t: "bid", kind: "bid", value: 300 });
  await h.until((r) => r.stake?.turnId === id(c));
  c.send({ t: "bid", kind: "allin" });
  // A (1000) can't beat 2000, so the turn goes straight to B.
  await h.until((r) => r.stake?.allIn === true && r.stake.turnId === id(b));
  b.send({ t: "bid", kind: "bid", value: 2500 });
  await new Promise((ok) => setTimeout(ok, 150));
  assert.ok(b.errors.length >= 2, "after an all-in an ordinary bid is refused");
  b.send({ t: "bid", kind: "allin" });
  const won = await h.until((r) => r.phase === "question" && r.question?.soloId === id(b));
  assert.equal(won.question?.price, 3000);

  // B answers right and chooses the cat in the bag (fixed 300, can't keep it).
  h.send({ t: "host", action: "open" });
  await h.until((r) => r.question?.answeringId === id(b), 15000);
  h.send({ t: "judge", correct: true });
  await h.until((r) => r.phase === "choosing" && r.chooserId === id(b), 10000);
  b.send({ t: "choose", theme: 1, index: 1 });
  const sec = await b.until((r) => r.phase === "secret");
  assert.ok(!sec.secret!.candidates.includes(id(b)), "the chooser can't keep this cat");
  b.send({ t: "giveSecret", to: id(a) });
  await h.until((r) => r.phase === "question" && r.question?.soloId === id(a));
  h.send({ t: "host", action: "open" });
  await h.until((r) => r.question?.answeringId === id(a), 15000);
  c.send({ t: "buzz" });
  h.send({ t: "judge", correct: false });
  const after = await h.until((r) => r.question?.stage === "reveal");
  assert.equal(after.players.find((p) => p.id === id(a))?.score, 700, "wrong cat answer costs 300");
  assert.equal(after.players.find((p) => p.id === id(c))?.score, 2000, "C's buzz was ignored: nobody else answers a cat");
  assert.equal(after.question?.wrongIds.length, 1, "only the recipient answered");
  h.close(); a.close(); b.close(); c.close();
});

test("stakes for everyone, for-everyone with options, number answer with deviation (auto host)", async () => {
  const a = new Client("Ставщик А");
  const b = new Client("Ставщик Б");
  await a.open(); await b.open();
  a.send({ t: "createRoom", name: "Ставки", settings: { hostMode: "auto", chooseTime: 0 }, asHost: false });
  const r0 = await a.until((r) => !!r.id);
  b.send({ t: "joinRoom", roomId: r0.id });
  await a.until((r) => r.players.length === 2);
  a.send({ t: "useDemoPack", id: "test-all-types.siq" });
  await a.until((r) => !!r.pack);
  a.send({ t: "start" });
  await a.until((r) => r.phase === "choosing", 10000);
  const ida = a.room!.me.id, idb = b.room!.me.id;
  a.send({ t: "setScore", id: ida, score: 1000 });
  a.send({ t: "setScore", id: idb, score: 500 });
  a.send({ t: "setChooser", playerId: ida });
  await a.until((r) => r.chooserId === ida && r.players.find((p) => p.id === idb)?.score === 500);
  a.send({ t: "choose", theme: 3, index: 0 }); // stakes for everyone
  await a.until((r) => r.phase === "stakeAll");
  a.send({ t: "stakeAll", value: 400 });
  b.send({ t: "stakeAll", value: 500 });
  await a.until((r) => r.question?.kind === "stakeAll" && r.question.stage === "open", 15000);
  a.send({ t: "submit", text: "1147" });
  b.send({ t: "submit", text: "1200" });
  const rev = await a.until((r) => r.question?.stage === "reveal");
  const d = Object.fromEntries(rev.question!.forAll!.answers!.map((x) => [x.id, x.delta]));
  assert.equal(d[ida], 400);
  assert.equal(d[idb], -500);

  await a.until((r) => r.phase === "choosing", 10000);
  const ch = a.room!.chooserId === ida ? a : b;
  ch.send({ t: "choose", theme: 3, index: 1 }); // for everyone with options, right = C
  const fq = await a.until((r) => r.question?.kind === "forAll" && r.question.stage === "open", 15000);
  assert.equal(fq.question?.options?.length, 4);
  a.send({ t: "submit", text: "C" });
  b.send({ t: "submit", text: "B" });
  const rev2 = await a.until((r) => r.question?.stage === "reveal" && r.question.index === 1);
  const d2 = Object.fromEntries(rev2.question!.forAll!.answers!.map((x) => [x.id, x.correct]));
  assert.equal(d2[ida], true);
  assert.equal(d2[idb], false);

  await a.until((r) => r.phase === "choosing", 10000);
  const ch2 = a.room!.chooserId === ida ? a : b;
  ch2.send({ t: "choose", theme: 3, index: 2 }); // number ±10
  await ch2.until((r) => r.question?.stage === "open" && r.question.index === 2, 15000);
  ch2.send({ t: "buzz" });
  await ch2.until((r) => r.question?.answeringId === r.me.id);
  ch2.send({ t: "submit", text: "примерно 995 метров" });
  const num = await ch2.until((r) => !!r.question?.lastResult && r.question.index === 2);
  assert.equal(num.question?.lastResult?.correct, true, "995 is within ±10 of 1000");
  a.close(); b.close();
});

test("voice chat link: only the host sets it, only http(s), players see it", async () => {
  const h = new Client("ГолосВедущий");
  const p = new Client("ГолосИгрок");
  await h.open(); await p.open();
  h.send({ t: "createRoom", name: "Голос", settings: { hostMode: "human" }, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  p.send({ t: "joinRoom", roomId: r0.id });
  await p.until((r) => r.id === r0.id);
  h.send({ t: "voice", url: "javascript:alert(1)" });
  p.send({ t: "voice", url: "https://evil.example" });
  await new Promise((ok) => setTimeout(ok, 200));
  assert.ok(h.errors.some((e) => /http/.test(e)), "non-http links are refused");
  assert.ok(p.errors.some((e) => /ведущий/.test(e)), "players can't set the link");
  h.send({ t: "voice", url: "https://discord.gg/abc123" });
  const seen = await p.until((r) => !!r.voiceUrl);
  assert.equal(seen.voiceUrl, "https://discord.gg/abc123");
  h.send({ t: "voice", url: null });
  await p.until((r) => !r.voiceUrl);
  h.close(); p.close();
});

test("pass: when everyone passes, the question ends at once; a passed player can't buzz", async () => {
  const a = new Client("Пас А");
  const b = new Client("Пас Б");
  await a.open(); await b.open();
  a.send({ t: "createRoom", name: "Пасы", settings: { hostMode: "auto", thinkTime: 60, chooseTime: 0 }, asHost: false });
  const r0 = await a.until((r) => !!r.id);
  b.send({ t: "joinRoom", roomId: r0.id });
  await a.until((r) => r.players.length === 2);
  a.send({ t: "useDemoPack", id: "demo.siq" });
  await a.until((r) => !!r.pack);
  a.send({ t: "start" });
  const ch = await a.until((r) => r.phase === "choosing", 10000);
  const chooser = ch.chooserId === ch.me.id ? a : b;
  chooser.send({ t: "choose", theme: 0, index: 1 });
  await a.until((r) => r.question?.stage === "open", 15000);
  a.send({ t: "passQuestion" });
  await a.until((r) => (r.question?.passedIds ?? []).includes(r.me.id));
  a.send({ t: "buzz" });
  await new Promise((ok) => setTimeout(ok, 150));
  assert.equal(a.room?.question?.stage, "open", "a passed player can't press the button");
  const t0 = Date.now();
  b.send({ t: "passQuestion" });
  const rev = await a.until((r) => r.question?.stage === "reveal");
  assert.ok(Date.now() - t0 < 2000, "no waiting for the 60 s think timer");
  assert.ok(rev.players.every((p) => p.score === 0), "passing costs nothing");
  a.close(); b.close();
});

test("host multipliers: ×2 doubles, ×−0,5 takes half, 0 changes nothing", async () => {
  const h = new Client("МножВедущий");
  const p = new Client("МножИгрок");
  await h.open(); await p.open();
  h.send({ t: "createRoom", name: "Множители", settings: { hostMode: "human", chooseTime: 0 }, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  p.send({ t: "joinRoom", roomId: r0.id });
  await h.until((r) => r.players.length === 1);
  h.send({ t: "useDemoPack", id: "demo.siq" });
  await h.until((r) => !!r.pack);
  h.send({ t: "start" });
  const score = () => h.room!.players[0].score;
  const play = async (theme: number, index: number, mult: -2 | -1 | -0.5 | 0 | 0.5 | 1 | 2) => {
    await h.until((r) => r.phase === "choosing", 15000);
    h.send({ t: "choose", theme, index });
    await h.until((r) => r.phase === "question" && r.question?.themeIndex === theme && r.question.index === index);
    h.send({ t: "host", action: "open" });
    await p.until((r) => r.question?.stage === "open" && r.question.index === index);
    p.send({ t: "buzz" });
    await h.until((r) => r.question?.answeringId === p.room!.me.id);
    h.send({ t: "judge", correct: mult > 0, mult });
    await h.until((r) => !!r.question?.lastResult && r.question.index === index);
    h.send({ t: "host", action: "next" });
  };
  await play(0, 1, 2); // 200 × 2
  assert.equal(score(), 400);
  await play(1, 1, -0.5); // 200 × −0,5
  assert.equal(score(), 300);
  await play(2, 1, 0); // nothing; others could still answer
  await h.until((r) => r.question?.stage !== "answering");
  assert.equal(score(), 300);
  h.close(); p.close();
});

test("rooms list, password and join by code", async () => {
  const a = new Client("Владелец");
  const b = new Client("Гость");
  await a.open(); await b.open();
  a.send({ t: "createRoom", name: "Закрытая", password: "123", settings: {}, asHost: true });
  const r = await a.until((x) => !!x.id);
  b.send({ t: "joinRoom", roomId: r.id, password: "000" });
  await new Promise((ok) => setTimeout(ok, 200));
  assert.ok(b.errors.includes("Неверный пароль"));
  b.send({ t: "joinRoom", roomId: r.id.toLowerCase(), password: "123" });
  const joined = await b.until((x) => x.id === r.id);
  assert.equal(joined.me.role, "player");
  a.close(); b.close();
});

test("packs with very long media names (URI-escaped Cyrillic) load and serve", async () => {
  const { buildSiq } = await import("@kvz/siq");
  const { loadPack } = await import("../src/packs.ts");
  const longName = "Лютик (полное имя — Юлиан Альфред Панкрац, виконт де Леттенхоф)  [из книг и игр про Ведьмака].jpg";
  const bytes = await buildSiq({
    name: "Длинные имена", authors: ["тест"],
    rounds: [{ name: "Р", themes: [{ name: "Т", questions: [{ price: 100, question: [{ type: "image", file: longName }, "Кто это?"], answer: ["Лютик"] }] }] }],
    files: { [`Images/${longName}`]: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
  });
  const pack = await loadPack(bytes, mkdtempSync(join(tmpdir(), "kvz-long-")));
  const media = pack.media(pack.opened.pack.rounds[0].themes[0].questions[0].content);
  const url = media.find((m) => m.type === "image")?.url;
  assert.ok(url, "the picture is found in the archive");
  assert.ok(encodeURI(longName).length > 255, "the escaped name really is longer than Windows allows");
});

test("select questions are judged from the pack; when only the right option is left, the question ends", async () => {
  const h = new Client("ВедущийВ");
  const ps = ["Вариант 1", "Вариант 2", "Вариант 3", "Вариант 4"].map((n) => new Client(n));
  await h.open();
  for (const p of ps) await p.open();
  const feed: ChatItem[] = [];
  h.ws.on("message", (raw) => { const m = JSON.parse(String(raw)) as ServerMsg; if (m.t === "chat") feed.push(...m.items); });
  h.send({ t: "createRoom", name: "Варианты", settings: { hostMode: "human", chooseTime: 0, wrongPenalty: true }, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  for (const [k, x] of ps.entries()) { x.send({ t: "joinRoom", roomId: r0.id }); await x.until((r) => r.id === r0.id); await h.until((r) => r.players.length === k + 1); }
  h.send({ t: "useDemoPack", id: "test-all-types.siq" });
  await h.until((r) => !!r.pack);
  h.send({ t: "start" });
  await h.until((r) => r.phase === "choosing", 10000);
  const id = (x: Client) => x.room!.me.id;
  h.send({ t: "setChooser", playerId: id(ps[0]) });
  await h.until((r) => r.chooserId === id(ps[0]));
  ps[0].send({ t: "choose", theme: 2, index: 3 }); // options A–D, right = B
  await h.until((r) => r.phase === "question" && r.question?.index === 3);
  h.send({ t: "host", action: "open" });
  // Three players pick the three wrong options; the host never judges.
  for (const [k, label] of [[0, "A"], [1, "C"], [2, "D"]] as const) {
    const p = ps[k];
    await p.until((r) => r.question?.stage === "open");
    p.send({ t: "buzz" });
    await p.until((r) => r.question?.answeringId === r.me.id);
    p.send({ t: "submit", text: label });
    if (k < 2) {
      const after = await h.until((r) => r.question?.wrongIds.includes(id(p)) === true);
      assert.equal(after.question?.options?.find((o) => o.label === label)?.wrong, true, "a wrong option is marked");
    }
  }
  const rev = await h.until((r) => r.question?.stage === "reveal");
  assert.equal(rev.players.find((p) => p.id === id(ps[3]))?.score, 0, "the last player gets no free points");
  assert.deepEqual(rev.players.slice(0, 3).map((p) => p.score), [-400, -400, -400]);
  assert.ok(feed.some((c) => c.kind === "ev" && c.line?.key === "ev.onlyRightLeft"));
  h.close(); ps.forEach((p) => p.close());
});

test("anonymous pack: players never receive its name, not even in media links or the rooms list", async () => {
  const h = new Client("ВедущийАнон");
  const p = new Client("ИгрокАнон");
  const lobby = new Client("СмотритСписок");
  await h.open(); await p.open(); await lobby.open();
  const raw: string[] = [];
  p.ws.on("message", (m) => raw.push(String(m)));
  lobby.ws.on("message", (m) => raw.push(String(m)));
  lobby.send({ t: "listRooms" });
  h.send({ t: "createRoom", name: "Анон", settings: { hostMode: "human", anonPack: true, chooseTime: 0 }, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  p.send({ t: "joinRoom", roomId: r0.id });
  await h.until((r) => r.players.length === 1);
  h.send({ t: "useDemoPack", id: "test-all-types.siq" });
  const hv = await h.until((r) => !!r.pack);
  assert.equal(hv.pack?.name, "Проверка всех типов вопросов", "the host knows the pack");
  assert.equal(hv.pack?.hidden, true);
  const pv = await p.until((r) => !!r.pack);
  assert.equal(pv.pack?.hidden, true);
  assert.match(pv.pack!.name, /^pack-[0-9a-f]{8}$/);
  assert.equal(pv.pack?.logo, undefined);
  h.send({ t: "start" });
  await h.until((r) => r.phase === "choosing", 10000);
  h.send({ t: "setChooser", playerId: p.room!.me.id });
  await p.until((r) => r.chooserId === r.me.id);
  p.send({ t: "choose", theme: 2, index: 2 }); // for everyone with a picture «флаг.svg»
  const q = await p.until((r) => !!r.question?.content.some((c) => c.type === "image"));
  const url = q.question!.content.find((c) => c.type === "image")!.url!;
  assert.match(url, /^\/media\/x\/[0-9a-f]{32}$/);
  const res = await fetch(`http://localhost:${srv.port}${url}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /svg/);
  lobby.send({ t: "listRooms" });
  await new Promise((ok) => setTimeout(ok, 400));
  // The welcome message lists the server's public demo packs; it says nothing about this room.
  // The rooms list also holds other tests' rooms with the same pack shown openly: keep only ours.
  const ours = raw.filter((m) => !m.startsWith('{"t":"welcome"')).map((m) => {
    const msg = JSON.parse(m) as ServerMsg;
    return msg.t === "rooms" ? JSON.stringify(msg.rooms.filter((x) => x.id === r0.id)) : m;
  });
  const all = ours.join("\n");
  for (const secret of ["Проверка всех типов", "флаг", "%D1%84%D0%BB%D0%B0%D0%B3"]) assert.ok(!all.includes(secret), `players got «${secret}»`);
  assert.ok(ours.some((m) => m.includes('"packHidden":true')), "the rooms list marks the pack as hidden");
  h.close(); p.close(); lobby.close();
});

test("anonymous pack switched on after loading: the name leaves the feed", async () => {
  const h = new Client("ВедущийАнон2");
  const p = new Client("ИгрокАнон2");
  await h.open(); await p.open();
  h.send({ t: "createRoom", name: "Анон2", settings: { hostMode: "human" }, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  p.send({ t: "joinRoom", roomId: r0.id });
  await h.until((r) => r.players.length === 1);
  h.send({ t: "useDemoPack", id: "demo.siq" });
  await p.until((r) => !!r.pack && !r.pack.hidden);
  const resets: string[] = [];
  p.ws.on("message", (m) => { const s = String(m); if (s.includes('"reset":true')) resets.push(s); });
  h.send({ t: "settings", settings: { anonPack: true } });
  const pv = await p.until((r) => r.pack?.hidden === true);
  assert.notEqual(pv.pack?.name, "Сборная солянка (демо)");
  await new Promise((ok) => setTimeout(ok, 200));
  assert.equal(resets.length, 1, "the feed is resent");
  assert.ok(!resets[0].includes("Сборная солянка"));
  h.close(); p.close();
});

test("leader and host: free a table, remove, ban, take and leave the host's seat", async () => {
  const lead = new Client("Лидер");
  const a = new Client("Стол А");
  const b = new Client("Стол Б");
  const c = new Client("Зритель В");
  for (const x of [lead, a, b, c]) await x.open();
  lead.send({ t: "createRoom", name: "Роли", settings: { maxPlayers: 3 }, asHost: false });
  const r0 = await lead.until((r) => !!r.id);
  assert.equal(r0.leaderId, r0.me.id);
  assert.equal(r0.host, undefined, "I play: the host's seat is free");
  for (const x of [a, b]) { x.send({ t: "joinRoom", roomId: r0.id }); await x.until((r) => r.id === r0.id); }
  c.send({ t: "joinRoom", roomId: r0.id, asViewer: true });
  await c.until((r) => r.id === r0.id);
  await lead.until((r) => r.players.length === 3 && r.viewers.length === 1);
  const id = (x: Client) => x.room!.me.id;

  // Anyone takes the free host's seat (open by default); the host is not the leader.
  c.send({ t: "takeHost" });
  const hosted = await lead.until((r) => r.host?.id === id(c));
  assert.equal(hosted.leaderId, id(lead));
  c.send({ t: "kick", id: id(a) });
  await c.error(0);
  assert.ok(lead.room!.players.some((p) => p.id === id(a)), "the host can't remove people");

  // Free a table: the player watches, the table stays.
  lead.send({ t: "freeSeat", id: id(a) });
  const freed = await lead.until((r) => !r.players.some((p) => p.id === id(a)));
  assert.equal(freed.settings.maxPlayers, 3);
  assert.ok(freed.viewers.some((v) => v.id === id(a)));

  // Remove: leaves the room, the table goes too.
  lead.send({ t: "kick", id: id(b) });
  const kicked = await lead.until((r) => !r.players.some((p) => p.id === id(b)) && r.settings.maxPlayers === 2);
  assert.ok(!kicked.viewers.some((v) => v.id === id(b)));
  const bid = id(b);
  b.send({ t: "joinRoom", roomId: r0.id });
  await lead.until((r) => r.players.some((p) => p.id === bid) || r.viewers.some((v) => v.id === bid));

  // Ban: can't come back.
  lead.send({ t: "ban", id: id(b) });
  await lead.until((r) => !r.viewers.some((v) => v.id === id(b)) && !r.players.some((p) => p.id === id(b)));
  const before = b.errors.length;
  b.send({ t: "joinRoom", roomId: r0.id });
  assert.match(await b.error(before), /не пускают/);

  // The leader sends the host to the viewers, then puts a viewer in the seat; the host leaves it.
  lead.send({ t: "setHost", id: null });
  await lead.until((r) => !r.host);
  lead.send({ t: "setHost", id: id(a) });
  await a.until((r) => r.me.role === "host");
  a.send({ t: "leaveHost" });
  await lead.until((r) => !r.host && r.viewers.some((v) => v.id === id(a)));

  // A closed seat: only the leader puts people there.
  lead.send({ t: "settings", settings: { openHost: false } });
  await lead.until((r) => r.settings.openHost === false);
  const n = c.errors.length;
  c.send({ t: "takeHost" });
  assert.match(await c.error(n), /лидер/);
  for (const x of [lead, a, b, c]) x.close();
});

test("host jumps forward: random card, skip the reading, end an unanswered question; 0 counts as a pass", async () => {
  const h = new Client("ВедущийШаг");
  const a = new Client("ИгрокШаг1");
  const b = new Client("ИгрокШаг2");
  for (const x of [h, a, b]) await x.open();
  h.send({ t: "createRoom", name: "Шаги", settings: { chooseTime: 0, thinkTime: 60 }, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  for (const x of [a, b]) { x.send({ t: "joinRoom", roomId: r0.id }); await x.until((r) => r.id === r0.id); }
  h.send({ t: "useDemoPack", id: "demo.siq" });
  await h.until((r) => !!r.pack && r.players.length === 2);
  h.send({ t: "start" });
  await h.until((r) => r.phase === "choosing", 10000);
  // No choose timer, yet "forward" picks a random card for the chooser.
  h.send({ t: "host", action: "advance" });
  const picked = await h.until((r) => r.phase !== "choosing");
  assert.ok(picked.question, "a card was picked");
  // Restart the round (the random card may be an auction or a cat): the board is full again.
  h.send({ t: "setRound", index: 0 });
  await h.until((r) => r.phase === "roundIntro" || (r.phase === "choosing" && r.board!.themes.every((th) => th.prices.every((p) => p != null))));
  if (h.room!.phase === "roundIntro") { h.send({ t: "host", action: "advance" }); await h.until((r) => r.phase === "choosing"); }
  const [ti, qi] = [1, 0]; // «Космос» 100: a plain question
  h.send({ t: "setChooser", playerId: a.room!.me.id });
  await a.until((r) => r.chooserId === r.me.id);
  a.send({ t: "choose", theme: ti, index: qi });
  await h.until((r) => r.question?.stage === "reading");
  h.send({ t: "host", action: "advance" });
  await h.until((r) => r.question?.stage === "open");
  a.send({ t: "buzz" });
  await h.until((r) => r.question?.stage === "answering");
  h.send({ t: "judge", correct: false, mult: 0 });
  const z = await h.until((r) => (r.question?.zeroIds ?? []).includes(a.room!.me.id));
  assert.equal(z.players.find((p) => p.id === a.room!.me.id)?.score, 0);
  assert.equal(z.question?.stage, "open", "a 0 lets the others answer");
  const t0 = Date.now();
  h.send({ t: "host", action: "advance" });
  await h.until((r) => r.question?.stage === "reveal");
  assert.ok(Date.now() - t0 < 2000, "no waiting for the 60 s think timer");
  h.send({ t: "host", action: "advance" });
  await h.until((r) => r.phase === "choosing");
  h.close(); a.close(); b.close();
});

test("a question with media waits until everyone's browser loaded it", async () => {
  const h = new Client("ВедущийМедиа");
  const a = new Client("ИгрокМедиа");
  await h.open(); await a.open();
  h.send({ t: "createRoom", name: "Медиа", settings: { chooseTime: 0 }, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  a.send({ t: "joinRoom", roomId: r0.id });
  await h.until((r) => r.players.length === 1);
  h.send({ t: "useDemoPack", id: "test-all-types.siq" });
  await h.until((r) => !!r.pack);
  h.send({ t: "start" });
  await h.until((r) => r.phase === "choosing", 10000);
  h.send({ t: "setChooser", playerId: a.room!.me.id });
  await a.until((r) => r.chooserId === r.me.id);
  a.send({ t: "choose", theme: 2, index: 2 }); // for everyone, with a picture
  const lq = await h.until((r) => !!r.question?.loading);
  assert.deepEqual(lq.question!.loading, { ready: 0, total: 2 });
  assert.equal(lq.timer?.kind, "load");
  a.send({ t: "mediaReady", key: "2:2" });
  await h.until((r) => r.question?.loading?.ready === 1);
  h.send({ t: "mediaReady", key: "2:2" });
  const go = await h.until((r) => !r.question?.loading && r.timer?.kind === "read");
  assert.equal(go.question?.stage, "reading");
  h.close(); a.close();
});

test("finals: «only the first» ends the game after one final, «all» plays the next", async () => {
  for (const finals of ["one", "all"] as const) {
    const h = new Client(`ВедущийФ-${finals}`);
    const a = new Client(`ИгрокФ-${finals}`);
    await h.open(); await a.open();
    h.send({ t: "createRoom", name: `Финалы ${finals}`, settings: { chooseTime: 0, finals }, asHost: true });
    const r0 = await h.until((r) => !!r.id);
    a.send({ t: "joinRoom", roomId: r0.id });
    await h.until((r) => r.players.length === 1);
    h.send({ t: "useDemoPack", id: "test-finals.siq" });
    await h.until((r) => r.pack?.name === "Два финала");
    h.send({ t: "start" });
    await h.until((r) => r.phase === "choosing", 10000);
    h.send({ t: "setScore", id: a.room!.me.id, score: 500 });
    h.send({ t: "setRound", index: 1 }); // first final
    await h.until((r) => r.phase === "finalThemes" || r.phase === "finalStakes", 10000);
    // Jump through: remove themes, stakes, answers, judging.
    for (let i = 0; i < 12 && h.room!.phase !== "finalJudge" && h.room!.phase !== "finalReveal"; i++) {
      const ph = h.room!.phase;
      const removed = h.room!.final?.themes.filter((x) => x.removed).length ?? 0;
      if (ph === "finalThemes") h.send({ t: "removeTheme", index: h.room!.final!.themes.findIndex((x) => !x.removed) });
      else if (ph === "finalStakes") a.send({ t: "finalStake", value: 100 });
      else if (ph === "finalAnswer") a.send({ t: "submit", text: "Пушкин" });
      await h.until((r) => r.phase !== ph || (r.final?.themes.filter((x) => x.removed).length ?? 0) > removed, 10000);
    }
    if (h.room!.phase === "finalJudge") h.send({ t: "judge", correct: true, playerId: a.room!.me.id });
    await h.until((r) => r.phase === "finalReveal");
    h.send({ t: "host", action: "next" });
    const after = await h.until((r) => r.phase !== "finalReveal", 10000);
    if (finals === "one") assert.equal(after.phase, "gameOver");
    else assert.notEqual(after.phase, "gameOver", "the second final follows");
    h.close(); a.close();
  }
});

test("after the game the leader opens the anonymous pack's name; it downloads only after the game", async () => {
  const h = new Client("ВедущийОткр");
  const a = new Client("ИгрокОткр");
  await h.open(); await a.open();
  h.send({ t: "createRoom", name: "Открыть", settings: { anonPack: true, chooseTime: 0 }, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  a.send({ t: "joinRoom", roomId: r0.id });
  await h.until((r) => r.players.length === 1);
  h.send({ t: "useDemoPack", id: "demo.siq" });
  await h.until((r) => !!r.pack);
  h.send({ t: "start" });
  await h.until((r) => r.phase === "choosing", 10000);
  const hostView = h.room!.pack!;
  assert.equal(hostView.downloadUrl, undefined, "no download during the game");
  h.send({ t: "revealPack" });
  assert.match(await h.error(h.errors.length), /после игры/);
  h.send({ t: "host", action: "end" });
  const over = await a.until((r) => r.phase === "gameOver");
  assert.equal(over.pack?.hidden, true);
  assert.equal(over.pack?.downloadUrl, undefined, "players get no link before the reveal");
  const hostOver = await h.until((r) => r.phase === "gameOver" && !!r.pack?.downloadUrl);
  const res = await fetch(`http://localhost:${srv.port}${hostOver.pack!.downloadUrl}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
  const w = new Client("СмотритСтатистику");
  await w.open();
  const statsNow = () => new Promise<ServerMsg>((ok) => { const on = (m: unknown) => { const msg = JSON.parse(String(m)) as ServerMsg; if (msg.t === "stats") { w.ws.off("message", on); ok(msg); } }; w.ws.on("message", on); w.send({ t: "listRooms" }); });
  const before = await statsNow();
  assert.ok(before.t === "stats" && before.stats.recent.some((g) => g.roomName === "Открыть" && g.packHidden && !g.packName), "the latest games keep the anonymous pack hidden");
  h.send({ t: "revealPack" });
  const shown = await a.until((r) => r.pack?.revealed === true);
  assert.equal(shown.pack?.name, "Сборная солянка (демо)");
  assert.ok(shown.pack?.downloadUrl);
  const after = await statsNow();
  assert.ok(after.t === "stats" && after.stats.recent.some((g) => g.roomName === "Открыть" && g.packName === "Сборная солянка (демо)"));
  assert.ok(after.t === "stats" && after.stats.top.some((p) => p.name === "Сборная солянка (демо)"), "shown, it counts in the top packs");
  h.close(); a.close(); w.close();
});

test("rooms close: no game started in time, or empty for too long", async () => {
  const quick = await startServer({ port: 0, packsDir: join(import.meta.dirname, "..", "..", "..", "packs"), dataDir: mkdtempSync(join(tmpdir(), "kvz-test-")), log: () => {},
    roomLimits: { lobbyMs: 600, emptyMs: 300, sweepMs: 100 } });
  try {
    const a = new Client("Закрытие", quick.port);
    await a.open();
    const left = new Promise<ServerMsg>((ok) => a.ws.on("message", (m) => { const msg = JSON.parse(String(m)) as ServerMsg; if (msg.t === "left") ok(msg); }));
    a.send({ t: "createRoom", name: "Не начнут", settings: {}, asHost: true });
    await a.until((r) => !!r.id);
    const msg = await left;
    assert.equal(msg.t === "left" && msg.text?.key, "left.expiredLobby");

    const b = new Client("Ушёл", quick.port);
    await b.open();
    b.send({ t: "createRoom", name: "Пустая", settings: {}, asHost: true });
    const rb = await b.until((r) => r.name === "Пустая");
    b.close();
    const watcher = new Client("Смотрит список", quick.port);
    await watcher.open();
    const t0 = Date.now();
    let gone = false;
    while (!gone && Date.now() - t0 < 3000) {
      const rooms = await new Promise<ServerMsg>((ok) => {
        const on = (m: unknown) => { const msg = JSON.parse(String(m)) as ServerMsg; if (msg.t === "rooms") { watcher.ws.off("message", on); ok(msg); } };
        watcher.ws.on("message", on);
        watcher.send({ t: "listRooms" });
      });
      gone = rooms.t === "rooms" && !rooms.rooms.some((x) => x.id === rb.id);
      if (!gone) await new Promise((ok) => setTimeout(ok, 100));
    }
    assert.ok(gone, "an empty room is closed");
    a.close(); watcher.close();
  } finally {
    await quick.close();
  }
});

/** Pack with pictures in two rounds (and one in an answer, which is never sent ahead). */
async function twoRoundPack() {
  const { buildSiq } = await import("@kvz/siq");
  const svg = (n: number) => `<svg xmlns='http://www.w3.org/2000/svg'><text>${n}</text></svg>`;
  return buildSiq({
    name: "Два раунда с картинками", authors: ["тест"],
    rounds: [
      { name: "Первый", themes: [{ name: "Т1", questions: [
        { price: 100, question: [{ type: "image", file: "a.svg" }, "Что это?"], answer: ["А"], answerMedia: [{ type: "image", file: "answer.svg" }] },
        { price: 200, question: [{ type: "image", file: "b.svg" }], answer: ["Б"] },
      ] }] },
      { name: "Второй", themes: [{ name: "Т2", questions: [{ price: 300, question: [{ type: "image", file: "c.svg" }], answer: ["В"] }] }] },
    ],
    files: { "Images/a.svg": svg(1), "Images/b.svg": svg(2), "Images/c.svg": svg(3), "Images/answer.svg": svg(4) },
  });
}

test("media of the round download ahead, the next round once everyone has it", async () => {
  const { writeFileSync } = await import("node:fs");
  const packsDir = mkdtempSync(join(tmpdir(), "kvz-packs-"));
  writeFileSync(join(packsDir, "two.siq"), await twoRoundPack());
  const quick = await startServer({ port: 0, packsDir, dataDir: mkdtempSync(join(tmpdir(), "kvz-test-")), log: () => {} });
  try {
    const a = new Client("Preload-A", quick.port);
    const b = new Client("Preload-B", quick.port);
    const got = new Map<Client, Extract<ServerMsg, { t: "preload" }>[]>([[a, []], [b, []]]);
    for (const c of [a, b]) c.ws.on("message", (raw) => { const m = JSON.parse(String(raw)) as ServerMsg; if (m.t === "preload") got.get(c)!.push(m); });
    await a.open(); await b.open();
    a.send({ t: "createRoom", name: "Заранее", settings: { chooseTime: 0 }, asHost: false });
    const r0 = await a.until((r) => !!r.id);
    b.send({ t: "joinRoom", roomId: r0.id });
    await a.until((r) => r.players.length === 2);
    a.send({ t: "useDemoPack", id: "two.siq" });
    await a.until((r) => !!r.pack);
    a.send({ t: "start" });
    await a.until((r) => r.phase === "roundIntro");
    const wait = async (c: Client, n: number) => { const t0 = Date.now(); while (got.get(c)!.length < n) { if (Date.now() - t0 > 3000) throw new Error("no preload"); await new Promise((ok) => setTimeout(ok, 20)); } };
    await wait(a, 1);
    const first = got.get(a)![0];
    assert.equal(first.round, 0);
    assert.equal(first.urls.length, 2, "both questions' pictures, not the answer's");
    assert.ok(!first.next);
    a.send({ t: "preloaded", round: 0 });
    await new Promise((ok) => setTimeout(ok, 200));
    assert.equal(got.get(a)!.length, 1, "the next round waits until everyone has this one");
    b.send({ t: "preloaded", round: 0 });
    await wait(a, 2); await wait(b, 2);
    const next = got.get(b)![1];
    assert.equal(next.round, 1);
    assert.ok(next.next);
    assert.equal(next.urls.length, 1);
    a.close(); b.close();
  } finally {
    await quick.close();
  }
});

/** What the leader's browser sends for a pack: content.xml and the encrypted files' list. */
async function shareOf(bytes: Uint8Array, big = false) {
  const { openPack } = await import("@kvz/siq");
  const { createHash, randomBytes } = await import("node:crypto");
  const opened = await openPack(bytes);
  const files = opened.files.map((f) => ({
    path: f.path, size: big ? 60 * 1048576 : 1000, hash: createHash("sha256").update(f.path).digest("hex"), key: randomBytes(32).toString("base64"),
  }));
  return { xml: opened.xml, files };
}

test("shared pack: the server gets only the questions; keys come when shown; start waits for the first round", async () => {
  const { readdirSync } = await import("node:fs");
  const dataDir = mkdtempSync(join(tmpdir(), "kvz-test-"));
  const quick = await startServer({ port: 0, dataDir, log: () => {}, roomLimits: { emptyMs: 200, sweepMs: 100 } });
  try {
    const h = new Client("Share-Host", quick.port);
    const b = new Client("Share-B", quick.port);
    const c = new Client("Share-C", quick.port);
    const raw = new Map<Client, string[]>([[h, []], [b, []], [c, []]]);
    const msgs = new Map<Client, ServerMsg[]>([[h, []], [b, []], [c, []]]);
    for (const x of [h, b, c]) x.ws.on("message", (m) => { raw.get(x)!.push(String(m)); msgs.get(x)!.push(JSON.parse(String(m))); });
    await h.open(); await b.open(); await c.open();
    h.send({ t: "createRoom", name: "Раздача", settings: { chooseTime: 0, anonPack: false }, asHost: true });
    const r0 = await h.until((r) => !!r.id);
    b.send({ t: "joinRoom", roomId: r0.id });
    c.send({ t: "joinRoom", roomId: r0.id });
    await h.until((r) => r.players.length === 2);

    // Too big: refused.
    h.send({ t: "sharePack", ...(await shareOf(await twoRoundPack(), true)) });
    assert.equal(await h.error(0), formatText("ru", { key: "err.packSize" }));

    const share = await shareOf(await twoRoundPack());
    h.send({ t: "sharePack", ...share });
    const lobby = await b.until((r) => !!r.pack?.shared);
    assert.equal(lobby.share?.total, 4);
    assert.equal(lobby.share?.firstRound, 3, "two questions' pictures and the answer's");
    assert.equal(lobby.share?.ready, false);
    const swarm = msgs.get(b)!.findLast((m) => m.t === "swarm" && m.id) as Extract<ServerMsg, { t: "swarm" }>;
    assert.equal(swarm.files.length, 4);
    for (const f of share.files) {
      assert.ok(!raw.get(b)!.some((m) => m.includes(f.key)), "no key reaches a player before its picture is shown");
      assert.ok(!raw.get(b)!.some((m) => m.includes(f.path)), "players never see file names");
    }

    // Nobody has the first round yet: the game waits (unless the leader insists).
    h.send({ t: "start" });
    assert.equal(await h.error(1), formatText("ru", { key: "err.shareNotReady" }));

    // Who has what goes to the others; signalling goes only to members of the room.
    const firstRound = swarm.order.slice(0, 3);
    h.send({ t: "have", files: swarm.files.map((_, i) => i), reset: true });
    b.send({ t: "have", files: firstRound, reset: true });
    const t0 = Date.now();
    while (!msgs.get(c)!.some((m) => m.t === "have" && m.from === b.room!.me.id)) {
      if (Date.now() - t0 > 2000) assert.fail("c doesn't learn what b has");
      await new Promise((ok) => setTimeout(ok, 20));
    }
    b.send({ t: "rtc", to: c.room!.me.id, data: { hello: 1 } });
    b.send({ t: "rtc", to: "nobody", data: { hello: 2 } });
    await new Promise((ok) => setTimeout(ok, 200));
    const rtc = msgs.get(c)!.filter((m) => m.t === "rtc");
    assert.equal(rtc.length, 1);
    assert.deepEqual(rtc[0], { t: "rtc", from: b.room!.me.id, data: { hello: 1 } });
    await h.until((r) => r.share?.people.find((p) => p.id === b.room!.me.id)?.firstRound === true);
    c.send({ t: "have", files: firstRound, reset: true });
    await h.until((r) => r.share?.ready === true);
    h.send({ t: "start" });
    await h.until((r) => r.phase === "choosing", 10000);

    // The picture's key arrives with the question.
    h.send({ t: "choose", theme: 0, index: 0 });
    const q = await b.until((r) => r.phase === "question" && !!r.question?.content.length);
    const pic = q.question!.content.find((m) => m.type === "image")!;
    assert.equal(pic.url, undefined);
    const aSvg = share.files.find((f) => f.path === "Images/a.svg")!;
    assert.equal(pic.key, aSvg.key);
    assert.equal(swarm.files[pic.file!].hash, aSvg.hash);
    const answerKey = share.files.find((f) => f.path === "Images/answer.svg")!.key;
    assert.ok(!raw.get(b)!.some((m) => m.includes(answerKey)), "the answer's picture key waits for the answer");

    // Everyone leaves: the room closes and the pack's file list leaves the disk.
    assert.equal(readdirSync(join(dataDir, "packs")).filter((f) => f.endsWith(".json")).length, 1);
    h.close(); b.close(); c.close();
    const t1 = Date.now();
    while (readdirSync(join(dataDir, "packs")).length) {
      if (Date.now() - t1 > 3000) assert.fail("the shared pack's list stays after the room closed");
      await new Promise((ok) => setTimeout(ok, 50));
    }
  } finally {
    await quick.close();
  }
});

test("a restart keeps people and rooms: the game goes on with its scores and countdown", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kvz-test-"));
  const packsDir = join(import.meta.dirname, "..", "..", "..", "packs");
  const first = await startServer({ port: 0, packsDir, dataDir, log: () => {}, persist: true, saveMs: 100 });
  const h = new Client("Рестарт Ведущий", first.port);
  const p = new Client("Рестарт Игрок", first.port);
  await h.open(); await p.open();
  h.send({ t: "createRoom", name: "Переживёт", settings: { chooseTime: 60 }, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  p.send({ t: "joinRoom", roomId: r0.id });
  await h.until((r) => r.players.length === 1);
  h.send({ t: "useDemoPack", id: "demo.siq" });
  await h.until((r) => !!r.pack);
  h.send({ t: "start" });
  await h.until((r) => r.phase === "choosing", 10000);
  h.send({ t: "setScore", id: p.room!.me.id, score: 300 });
  await h.until((r) => r.players[0].score === 300);
  await first.close();

  const second = await startServer({ port: 0, packsDir, dataDir, log: () => {}, persist: true, saveMs: 100 });
  try {
    const h2 = new Client("Рестарт Ведущий", second.port);
    const feed: ChatItem[] = [];
    h2.ws.on("message", (raw) => { const m = JSON.parse(String(raw)) as ServerMsg; if (m.t === "chat") feed.push(...m.items); });
    await h2.open();
    const back = await h2.until((r) => r.id === r0.id);
    assert.equal(back.me.role, "host", "the same person comes back by their token");
    assert.equal(back.phase, "choosing");
    assert.equal(back.players[0].score, 300);
    assert.equal(back.timer?.kind, "choose", "the countdown goes on");
    assert.ok(feed.some((c) => c.line?.key === "ev.restored"));
    // The game really goes on.
    const p2 = new Client("Рестарт Игрок", second.port);
    await p2.open();
    await p2.until((r) => r.id === r0.id);
    h2.send({ t: "choose", theme: 0, index: 0 });
    await h2.until((r) => r.phase === "question");
    h2.close(); p2.close();
  } finally {
    await second.close();
  }
});

test("limits: a flood of messages is cut, too many connections from one address are refused", async () => {
  const quick = await startServer({ port: 0, dataDir: mkdtempSync(join(tmpdir(), "kvz-test-")), log: () => {}, maxPerIp: 2 });
  try {
    const a = new Client("Флуд", quick.port);
    await a.open();
    a.send({ t: "createRoom", name: "Флуд", settings: {}, asHost: false });
    await a.until((r) => !!r.id);
    for (let i = 0; i < 100; i++) a.send({ t: "ready", value: i % 2 === 0 });
    assert.equal(await a.error(0), formatText("ru", { key: "err.slowDown" }));
    const b = new Client("Второй адрес", quick.port);
    await b.open();
    const c = new Client("Третий", quick.port);
    const code = await new Promise<number>((ok) => c.ws.on("close", (n) => ok(n)));
    assert.equal(code, 4029);
    a.close(); b.close();
  } finally {
    await quick.close();
  }
});

test("leaving frees the seat; someone gone for long gives it up too", async () => {
  // Leaves in the middle of a game: off the table at once (the seat stays, free).
  const a = new Client("Уходит А");
  const b = new Client("Уходит Б");
  const c = new Client("Уходит В");
  for (const x of [a, b, c]) await x.open();
  a.send({ t: "createRoom", name: "Уход", settings: { hostMode: "auto" }, asHost: false });
  const r0 = await a.until((r) => !!r.id);
  for (const x of [b, c]) { x.send({ t: "joinRoom", roomId: r0.id }); await x.until((r) => r.id === r0.id); }
  a.send({ t: "useDemoPack", id: "demo.siq" });
  await a.until((r) => !!r.pack && r.players.length === 3);
  a.send({ t: "start", force: true });
  await a.until((r) => r.phase === "choosing", 10000);
  const cid = c.room!.me.id;
  c.send({ t: "leaveRoom" });
  const after = await a.until((r) => !r.players.some((p) => p.id === cid));
  assert.equal(after.players.length, 2);
  assert.notEqual(after.chooserId, cid);
  for (const x of [a, b, c]) x.close();

  // Closed the tab without a word: the keeper's sweep frees the seat after a while.
  const users = new Map<string, { id: string; name: string; online: boolean; send: () => void; lastChat: number; token: string; roomId?: string }>();
  const mk = (id: string) => { const u = { id, name: id, online: true, send: () => {}, lastChat: 0, token: "" }; users.set(id, u); return u; };
  const owner = mk("o"), p = mk("p");
  const room = new Room("SWEP", { user: (id) => users.get(id), roomsChanged: () => {} }, owner, { name: "Метла", settings: {}, asHost: false });
  room.join(owner);
  room.join(p);
  assert.equal(room.players.length, 2);
  const t0 = Date.now();
  p.online = false;
  room.sweepOffline(t0);
  room.sweepOffline(t0 + OFFLINE_LOBBY_MS - 1000);
  assert.equal(room.players.length, 2, "a reload or a short drop keeps the seat");
  room.sweepOffline(t0 + OFFLINE_LOBBY_MS + 1);
  assert.deepEqual(room.players.map((x) => x.id), ["o"]);
  assert.ok(!room.members.has("p"));
  room.dispose();
});

test("point questions: a click on the picture is judged by distance; the zone shows at the reveal", async () => {
  const a = new Client("Точка А");
  const b = new Client("Точка Б");
  await a.open(); await b.open();
  a.send({ t: "createRoom", name: "Точки", settings: { hostMode: "auto", chooseTime: 0 }, asHost: false });
  const r0 = await a.until((r) => !!r.id);
  b.send({ t: "joinRoom", roomId: r0.id });
  await a.until((r) => r.players.length === 2);
  a.send({ t: "useDemoPack", id: "test-all-types.siq" });
  await a.until((r) => !!r.pack);
  a.send({ t: "start" });
  await a.until((r) => r.phase === "choosing", 10000);
  const ida = a.room!.me.id;
  a.send({ t: "setChooser", playerId: ida });
  await a.until((r) => r.chooserId === ida);
  a.send({ t: "choose", theme: 3, index: 3 }); // green circle at 75% × 69%
  const open = await b.until((r) => r.question?.stage === "open" && r.question.index === 3, 15000);
  assert.ok(open.question?.point, "a point question says so");
  assert.equal(open.question?.point?.answer, undefined, "players don't see the spot before the reveal");

  // Too far: wrong, the click stays on the picture for everyone.
  b.send({ t: "buzz" });
  await b.until((r) => r.question?.answeringId === r.me.id);
  b.send({ t: "submit", text: "Зелёный круг" });
  b.send({ t: "submit", text: "0.2,0.3,0.5625" });
  const miss = await a.until((r) => r.question?.lastResult?.correct === false);
  assert.equal(miss.question?.point?.tries.length, 1, "text isn't an answer to a point question; the click is");
  assert.equal(miss.question?.point?.tries[0].correct, false);

  // Close enough (within 9% of the width): right.
  await a.until((r) => r.question?.stage === "open");
  a.send({ t: "buzz" });
  await a.until((r) => r.question?.answeringId === r.me.id);
  a.send({ t: "submit", text: "0.70,0.62,0.5625" });
  const hit = await b.until((r) => r.question?.stage === "reveal" && r.question.index === 3);
  assert.equal(hit.question?.lastResult?.correct, true);
  assert.deepEqual(hit.question?.point?.answer, { x: 0.75, y: 0.6944, dev: 0.09 });
  assert.equal(hit.question?.point?.tries.length, 2);
  a.close(); b.close();
});

test("the host who leaves or is away 2 minutes frees the seat; anyone may take it", async () => {
  // Leaves with the button: off the seat at once, the automatic host carries on.
  const h = new Client("Ведущий уходит");
  const p = new Client("Игрок остаётся");
  const v = new Client("Зритель садится");
  for (const x of [h, p, v]) await x.open();
  h.send({ t: "createRoom", name: "Уход ведущего", settings: { hostMode: "human", openHost: false }, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  p.send({ t: "joinRoom", roomId: r0.id });
  v.send({ t: "joinRoom", roomId: r0.id, asViewer: true });
  await h.until((r) => r.players.length === 1 && r.viewers.length === 1);
  const hid = h.room!.me.id;
  h.send({ t: "leaveRoom" });
  const after = await p.until((r) => !r.host && !r.viewers.some((x) => x.id === hid));
  assert.equal(after.settings.hostMode, "auto");
  assert.equal(after.settings.openHost, true, "the free seat is open to anyone");
  v.send({ t: "takeHost" });
  await p.until((r) => r.host?.id === v.room!.me.id);
  for (const x of [h, p, v]) x.close();

  // Away for 2 minutes: the keeper's sweep frees the seat and drops them from the room.
  const users = new Map<string, { id: string; name: string; online: boolean; send: () => void; lastChat: number; token: string; roomId?: string }>();
  const mk = (id: string) => { const u = { id, name: id, online: true, send: () => {}, lastChat: 0, token: "" }; users.set(id, u); return u; };
  const host = mk("h"), pl = mk("p"), viewer = mk("v");
  const room = new Room("HOST", { user: (id) => users.get(id), roomsChanged: () => {} }, host, { name: "Метла", settings: { hostMode: "human" }, asHost: true });
  room.join(host, undefined, true);
  room.join(pl);
  room.join(viewer, undefined, true);
  assert.equal(room.hostId, "h");
  host.online = false;
  viewer.online = false;
  const t0 = Date.now();
  room.sweepOffline(t0);
  room.sweepOffline(t0 + OFFLINE_GAME_MS - 1000);
  assert.equal(room.hostId, "h", "a short absence keeps the seat");
  room.sweepOffline(t0 + OFFLINE_GAME_MS + 1);
  assert.equal(room.hostId, undefined);
  assert.ok(!room.members.has("h") && !room.members.has("v"), "the host and the viewer are gone from the room");
  assert.equal(room.leaderId(), "p", "whoever is still here leads");
  room.dispose();
});

test("the leader hands the room over; reactions are few per person; someone away shows when they'll go", () => {
  const users = new Map<string, { id: string; name: string; online: boolean; link?: 1 | 2 | 3; send: (m: ServerMsg) => void; lastChat: number; token: string; roomId?: string }>();
  const got = new Map<string, ServerMsg[]>();
  const mk = (id: string) => {
    got.set(id, []);
    const u: { id: string; name: string; online: boolean; link?: 1 | 2 | 3; send: (m: ServerMsg) => void; lastChat: number; token: string } = { id, name: id, online: true, send: (m: ServerMsg) => { got.get(id)!.push(m); }, lastChat: 0, token: "" };
    users.set(id, u);
    return u;
  };
  const o = mk("o"), p = mk("p"), q = mk("q"), v = mk("v");
  const room = new Room("LEAD", { user: (id) => users.get(id), roomsChanged: () => {} }, o, { name: "Лидер", settings: {}, asHost: false });
  for (const u of [o, p, q]) room.join(u);
  room.join(v, undefined, true);

  // Leadership
  assert.equal(room.leaderId(), "o");
  assert.ok(room.setLeader("p", "q"), "only the leader hands it over");
  assert.equal(room.setLeader("o", "q"), null);
  assert.equal(room.leaderId(), "q", "the creator handed it over: no longer theirs while here");
  assert.equal(room.view("p").leaderId, "q");
  q.online = false;
  assert.equal(room.leaderId(), "o", "the new leader away: back to the usual order");
  q.online = true;
  assert.equal(room.leaderId(), "q");
  room.leave(q);
  assert.equal(room.leaderId(), "o", "gone for good: the pick is forgotten");

  // Reactions: to everyone online, at most one at a time per person, only the known ones.
  room.react("v", "👏");
  room.react("v", "😂");
  room.react("v", "💩");
  const reacts = (id: string) => got.get(id)!.filter((m) => m.t === "react");
  assert.deepEqual(reacts("o"), [{ t: "react", from: "v", e: "👏" }]);
  assert.equal(reacts("p").length, 1);
  room.react("p", "🔥");
  assert.equal(reacts("o").length, 2, "each person has their own allowance");

  // Away: the countdown everyone sees; the way the room reaches someone online.
  const t0 = Date.now();
  p.online = false;
  room.sweepOffline(t0);
  const away = room.view("o").players.find((x) => x.id === "p")!;
  assert.equal(away.online, false);
  assert.equal(away.goneAt, t0 + OFFLINE_LOBBY_MS);
  p.online = true;
  p.link = 3;
  room.sweepOffline(t0 + 1000);
  const back = room.view("o").players.find((x) => x.id === "p")!;
  assert.equal(back.goneAt, undefined);
  assert.equal(back.link, 3);
  room.dispose();
});

test("point questions in a stake for everyone and in the final: judged by the spot, everyone's clicks shown", async () => {
  const a = new Client("Финал-точка А");
  const b = new Client("Финал-точка Б");
  await a.open(); await b.open();
  a.send({ t: "createRoom", name: "Точки в финале", settings: { hostMode: "auto", chooseTime: 0 }, asHost: false });
  const r0 = await a.until((r) => !!r.id);
  b.send({ t: "joinRoom", roomId: r0.id });
  await a.until((r) => r.players.length === 2);
  a.send({ t: "useDemoPack", id: "test-all-types.siq" });
  await a.until((r) => !!r.pack);
  a.send({ t: "start" });
  await a.until((r) => r.phase === "choosing", 10000);
  const ida = a.room!.me.id, idb = b.room!.me.id;
  a.send({ t: "setScore", id: ida, score: 500 });
  a.send({ t: "setScore", id: idb, score: 500 });
  a.send({ t: "setChooser", playerId: ida });
  await a.until((r) => r.chooserId === ida && r.players.every((p) => p.score === 500));

  // A stake for everyone, answered with a click.
  a.send({ t: "choose", theme: 3, index: 5 });
  await a.until((r) => r.phase === "stakeAll", 10000);
  a.send({ t: "stakeAll", value: 100 });
  b.send({ t: "stakeAll", value: 200 });
  await a.until((r) => r.question?.stage === "open" && !!r.question.point, 15000);
  a.send({ t: "submit", text: "треугольник" });
  a.send({ t: "submit", text: "0.47,0.44,0.5625" });
  b.send({ t: "submit", text: "0.9,0.1,0.5625" });
  const rev = await b.until((r) => r.question?.stage === "reveal", 15000);
  assert.equal(rev.question?.point?.tries.length, 2, "both clicks are on the picture at the reveal");
  assert.equal(rev.players.find((p) => p.id === ida)?.score, 600);
  assert.equal(rev.players.find((p) => p.id === idb)?.score, 300);

  // The final, with the picture theme left.
  a.send({ t: "setRound", index: 1 });
  await a.until((r) => r.phase === "finalThemes", 10000);
  for (let i = 0; i < 4 && a.room!.phase === "finalThemes"; i++) {
    const f = a.room!.final!;
    const idx = f.themes.findIndex((th) => !th.removed && th.name !== "Картинка");
    const who = f.turnId === ida ? a : b;
    const removed = f.themes.filter((th) => th.removed).length;
    who.send({ t: "removeTheme", index: idx });
    await a.until((r) => r.phase !== "finalThemes" || r.final!.themes.filter((th) => th.removed).length > removed, 10000);
  }
  await a.until((r) => r.phase === "finalStakes", 10000);
  a.send({ t: "finalStake", value: 100 });
  b.send({ t: "finalStake", value: 100 });
  await a.until((r) => r.phase === "finalAnswer" && !!r.question?.point, 10000);
  a.send({ t: "submit", text: "квадрат" });
  a.send({ t: "submit", text: "0.21,0.37,0.5625" });
  b.send({ t: "submit", text: "0.8,0.8,0.5625" });
  const fin = await b.until((r) => r.phase === "finalReveal", 15000);
  assert.deepEqual(fin.final?.answers?.map((x) => x.correct), [true, false].slice(0, fin.final!.answers!.length).map((_, i) => fin.final!.answers![i].id === ida));
  assert.equal(fin.question?.point?.tries.length, 2, "everyone's spots at the final's reveal");
  assert.deepEqual(fin.question?.point?.answer, { x: 0.2031, y: 0.3611, dev: 0.1 });
  assert.ok(!formatText("ru", fin.hostLine!).includes("0.2031"), "the host says the spot as people read it");
  assert.equal(fin.players.find((p) => p.id === ida)?.score, 700);
  a.close(); b.close();
});

test("the last one to leave with the button deletes the room at once", async () => {
  const h = new Client("Один в лобби");
  const w = new Client("Смотрит список");
  await h.open(); await w.open();
  h.send({ t: "createRoom", name: "Сразу пустая", settings: {}, asHost: true });
  const r0 = await h.until((r) => !!r.id);
  const listed = () => new Promise<RoomSummary[]>((ok) => {
    const on = (raw: WebSocket.RawData) => { const m = JSON.parse(String(raw)) as ServerMsg; if (m.t === "rooms") { w.ws.off("message", on); ok(m.rooms); } };
    w.ws.on("message", on);
    w.send({ t: "listRooms" });
  });
  assert.ok((await listed()).some((x) => x.id === r0.id));
  h.send({ t: "leaveRoom" });
  await new Promise((ok) => setTimeout(ok, 200));
  assert.ok(!(await listed()).some((x) => x.id === r0.id), "no waiting 5 minutes for an empty room");
  h.send({ t: "joinRoom", roomId: r0.id });
  assert.ok(await h.error(h.errors.length), "the code leads nowhere now");
  h.close(); w.close();
});

test("rooms close on their own: a lobby nobody starts, a quiet game, the results, nobody at the table; the leader can close", () => {
  const users = new Map<string, { id: string; name: string; online: boolean; send: () => void; lastChat: number; token: string; roomId?: string }>();
  const mk = (id: string) => { const u = { id, name: id, online: true, send: () => {}, lastChat: 0, token: "" }; users.set(id, u); return u; };
  const closed: string[] = [];
  const hub = { user: (id: string) => users.get(id), roomsChanged: () => {}, closeRoom: (_r: Room, why: { key: string }) => { closed.push(why.key); } };
  const o = mk("o"), p = mk("p"), v = mk("v");
  const fresh = (name: string) => { const r = new Room(name, hub, o, { name, settings: {}, asHost: false }); r.join(o); r.join(p); r.join(v, undefined, true); return r; };
  const now = Date.now();

  // The lobby: a warning 2 minutes before 15; the leader (only) gives it another 15.
  const lobby = fresh("LOBB");
  lobby.lifecycle(now);
  assert.equal(lobby.view("o").closing, undefined, "no warning yet");
  lobby.lobbySince = now - LOBBY_MS + 60_000;
  lobby.lifecycle(now);
  assert.equal(lobby.view("o").closing?.why, "lobby");
  assert.equal(lobby.view("o").closing?.canExtend, true);
  assert.equal(lobby.view("p").closing?.canExtend, false, "only the leader extends a lobby");
  assert.ok(lobby.extend("p"));
  assert.equal(lobby.extend("o", now), null);
  lobby.lifecycle(now + 61_000);
  assert.deepEqual(closed, [], "extended: still open");
  lobby.lifecycle(now + LOBBY_MS + 1);
  assert.deepEqual(closed, ["left.expiredLobby"]);
  lobby.dispose();

  // A game where nobody does anything: a warning after 30 minutes, closed 2 minutes later; anyone can keep it.
  const quiet = fresh("QUIE");
  quiet.phase = "choosing";
  quiet.lastActivity = now - IDLE_MS - 30_000;
  quiet.lifecycle(now);
  assert.equal(quiet.view("v").closing?.why, "idle");
  assert.equal(quiet.view("v").closing?.canExtend, true);
  quiet.extend("v", now);
  assert.equal(quiet.view("v").closing, undefined, "«we're here» takes the warning away");
  quiet.lifecycle(now + IDLE_MS + WARN_MS + 1);
  assert.deepEqual(closed.slice(1), ["left.idle"]);
  quiet.dispose();

  // The results: everyone back to the list 5 minutes after.
  const over = fresh("OVER");
  over.phase = "gameOver";
  over.overSince = now;
  over.lifecycle(now);
  assert.equal(over.view("o").closing?.why, "over");
  over.lifecycle(now + OVER_MS + 1);
  assert.deepEqual(closed.slice(2), ["left.over"]);
  over.dispose();

  // Only viewers left: closed after 2 minutes.
  const empty = fresh("EMPT");
  empty.leave(o);
  empty.leave(p);
  empty.lifecycle(now);
  assert.equal(empty.view("v").closing?.why, "empty");
  empty.lifecycle(now + NO_SEATS_MS + 1);
  assert.deepEqual(closed.slice(3), ["left.noSeats"]);
  empty.dispose();

  // The leader closes it at once; nobody else can.
  const byLeader = fresh("LEAD");
  assert.ok(byLeader.closeByLeader("p"));
  assert.equal(byLeader.closeByLeader("o"), null);
  assert.deepEqual(closed.slice(4), ["left.closedByLeader"]);
  byLeader.dispose();
});

test("room names don't repeat", async () => {
  const a = new Client("Имя А");
  const b = new Client("Имя Б");
  await a.open(); await b.open();
  a.send({ t: "createRoom", name: "Ёлка у Димы", settings: {}, asHost: true });
  await a.until((r) => r.name === "Ёлка у Димы");
  b.send({ t: "createRoom", name: "  елка у  ДИМЫ ", settings: {}, asHost: true });
  assert.match(await b.error(0), /таким названием/);
  assert.equal(b.room, undefined, "no room made");
  b.send({ t: "createRoom", name: "Ёлка у Димы 2", settings: {}, asHost: true });
  await b.until((r) => r.name === "Ёлка у Димы 2");
  a.close(); b.close();
});
