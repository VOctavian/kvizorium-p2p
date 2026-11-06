import { useEffect, useMemo, useState } from "react";
import { DEFAULT_SETTINGS, type ChatItem, type MediaView, type PlayerView, type QuestionView, type RoomView, type TimerView } from "@kvz/protocol";
import { enterPreview } from "../net.ts";
import { RoomScreen } from "./Room.tsx";

/**
 * Screens of every question type, built on made-up data with the real game components.
 * Open with #showcase. Nothing is sent to a server.
 */

const svg = (body: string, bg: string) =>
  "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="${bg}"/>${body}</svg>`);
const IMG = {
  mars: svg(`<defs><radialGradient id="g" cx=".35" cy=".3"><stop offset="0" stop-color="#ffb38a"/><stop offset=".55" stop-color="#c4552d"/><stop offset="1" stop-color="#5e1c0f"/></radialGradient></defs><circle cx="320" cy="180" r="130" fill="url(#g)"/>`, "#0c1030"),
  earth: svg(`<circle cx="320" cy="180" r="130" fill="#3b6dff"/><path d="M230 140q40-50 90-20t60 60q-30 40-80 20t-70-60z" fill="#43f0c4"/>`, "#0c1030"),
  flag: svg(`<rect width="640" height="120" fill="#fff"/><rect y="120" width="640" height="120" fill="#0039a6"/><rect y="240" width="640" height="120" fill="#d52b1e"/>`, "#000"),
  triangle: svg(`<path d="M320 60 L520 300 L120 300 Z" fill="#ff74b3"/>`, "#1a0f2a"),
};
const VIDEO = "showcase/planets.webm";

type Kind = "lobby" | "text" | "media" | "options" | "secret" | "forAll" | "stake" | "stakeAll";
const KINDS: [Kind, string][] = [
  ["lobby", "Лобби"],
  ["text", "Текстовый вопрос"],
  ["media", "Текст + медиа"],
  ["options", "Варианты ответа"],
  ["secret", "Кот в мешке"],
  ["forAll", "Вопрос для всех"],
  ["stake", "Аукцион"],
  ["stakeAll", "Ставка для всех"],
];
const STEPS: Record<Kind, [string, string][]> = {
  lobby: [["seats", "Места за столом"], ["anon", "Анонимный пак"]],
  text: [["read", "Чтение (караоке)"], ["open", "Кнопки открыты"], ["answer", "Отвечает игрок"], ["reveal", "Правильный ответ"]],
  media: [["read", "Вопрос: текст и 2 картинки"], ["open", "Кнопки открыты"], ["single", "Одна картинка, длинный текст"], ["reveal", "Ответ: текст, картинка и видео"]],
  options: [["answer", "Выбор варианта"], ["wrong", "Один вариант отпал"]],
  secret: [["give", "Кому отдать"], ["price", "Выбор цены"], ["answer", "Отвечает только получатель"], ["wrong", "Ошибся — другие не отвечают"]],
  forAll: [["text", "Пишут ответ"], ["options", "Кнопки вариантов"], ["judging", "Ведущий проверяет"], ["reveal", "Итоги"]],
  stake: [["turn", "Ваш ход: ставка"], ["allin", "После ва-банка"], ["answer", "Отвечает победитель торгов"], ["reveal", "Итог"]],
  stakeAll: [["bet", "Тайные ставки"], ["write", "Пишут ответ"], ["reveal", "Итоги по ставкам"]],
};

const timer = (kind: TimerView["kind"], left: number, total = left): TimerView => ({ kind, endsAt: Date.now() + left * 1000, duration: total });
const text = (t: string): MediaView => ({ type: "text", text: t, placement: "screen" });
const image = (url: string): MediaView => ({ type: "image", url, placement: "screen" });

function scene(kind: Kind, step: string, role: "player" | "host"): RoomView {
  const meId = role === "host" ? "host" : "me";
  const rich = kind === "stake" || kind === "stakeAll";
  const players: PlayerView[] = [
    { id: "me", name: "Саша", score: rich ? 1500 : 600, ready: true, online: true },
    { id: "max", name: "Макс", score: 1200, ready: true, online: true, gender: "m" },
    { id: "lera", name: "Лера", score: 800, ready: true, online: true, gender: "f" },
    { id: "dima", name: "Дима", score: -200, ready: true, online: true, gender: "m" },
  ];
  const base: RoomView = {
    id: "DEMO",
    name: "Витрина вопросов",
    hasPassword: false,
    settings: { ...DEFAULT_SETTINGS, readSpeed: 16 },
    ownerId: "host",
    leaderId: "host",
    me: { id: meId, role },
    host: { id: "host", name: "Аня", online: true, gender: "f" },
    players,
    viewers: [],
    pack: { name: "Витрина вопросов", authors: ["Квизориум"], rounds: [{ name: "Типы вопросов", final: false, themes: 5, questions: 25 }], questions: 25, version: 5, sizeMb: 0.2 },
    phase: "question",
    paused: false,
    board: { index: 0, count: 1, name: "Типы вопросов", final: false, themes: [{ name: "Космос", prices: [100, 200, null, 400, 500] }] },
    chooserId: "max",
    hostLine: { key: "raw", params: { text: "" } },
    serverNow: 0,
  };
  const line = (t: string) => ({ key: "raw" as const, params: { text: t } });
  const q = (over: Partial<QuestionView>): QuestionView => ({
    themeIndex: 0, index: 2, theme: "Космос", price: 300, kind: "simple", stage: "open", content: [], wrongIds: [], passedIds: [], ...over,
  });
  const hostAnswer = (a: string[], content: MediaView[] = []) => (role === "host" ? { text: a, content } : undefined);

  switch (kind) {
    case "lobby":
      {
        const anon = step === "anon";
        const pack = !anon ? base.pack : role === "host" ? { ...base.pack!, hidden: true } : { ...base.pack!, name: "pack-5e1f09ac", authors: [], sizeMb: 0, hidden: true };
        return { ...base, phase: "lobby", board: undefined, question: undefined, pack, players: players.slice(0, 2).map((p) => ({ ...p, score: 0 })), settings: { ...base.settings, maxPlayers: 5, anonPack: anon }, hostLine: line("Пак готов. Ждём, пока все нажмут «Готов»") };
      }
    case "text": {
      const content = [text("Самый высокий вулкан Солнечной системы находится на Марсе. Как он называется?")];
      if (step === "read") return { ...base, hostLine: line("«Космос» за 300"), question: q({ stage: "reading", content, answer: hostAnswer(["Олимп"]) }), timer: timer("read", 5.5) };
      if (step === "open") return { ...base, hostLine: line("Неверно. Кто ещё попробует?"), question: q({ content, answer: hostAnswer(["Олимп"]), wrongIds: ["max"], passedIds: ["dima"] }), timer: timer("think", 10) };
      if (step === "answer") {
        const who = role === "host" ? "lera" : "me";
        return { ...base, hostLine: line(`${who === "me" ? "Саша" : "Лера"}, ваш ответ?`), question: q({ stage: "answering", content, answeringId: who, typed: role === "host" ? "Олимп" : undefined, answer: hostAnswer(["Олимп"]) }), timer: timer("answer", 30) };
      }
      return { ...base, hostLine: line("Правильный ответ: Олимп"), question: q({ stage: "reveal", content, answer: { text: ["Олимп", "Гора Олимп"], content: [] }, lastResult: { playerId: "lera", correct: true, delta: 300 } }), timer: timer("reveal", 4) };
    }
    case "media": {
      const content = [text("Что общего у этих планет? Назовите одним словом."), image(IMG.mars), image(IMG.earth)];
      const answer = { text: ["Планеты земной группы", "Земная группа"], content: [image(IMG.triangle), { type: "video" as const, url: VIDEO, placement: "screen" as const }] };
      if (step === "read") return { ...base, hostLine: line("«Космос» за 400"), question: q({ price: 400, stage: "reading", content, answer: role === "host" ? { ...answer, content: [] } : undefined }), timer: timer("read", 6) };
      if (step === "open") return { ...base, hostLine: line("Кнопки открыты!"), question: q({ price: 400, content, answer: role === "host" ? { ...answer, content: [] } : undefined }), timer: timer("think", 10) };
      if (step === "single") {
        const long = [text("Перед вами снимок планеты, сделанный автоматической станцией с орбиты: назовите планету, её самый высокий вулкан и год, когда его впервые увидели в телескоп"), image(IMG.mars)];
        return { ...base, hostLine: line("Кнопки открыты!"), question: q({ price: 400, content: long, answer: role === "host" ? { text: ["Марс"], content: [] } : undefined }), timer: timer("think", 10) };
      }
      return { ...base, hostLine: line("Правильный ответ: Планеты земной группы"), question: q({ price: 400, stage: "reveal", content, answer, lastResult: { playerId: "max", correct: true, delta: 400 } }), timer: timer("reveal", 6) };
    }
    case "options": {
      const content = [text("Какая планета самая большая в Солнечной системе?")];
      const opts = [{ label: "A", text: "Марс" }, { label: "B", text: "Юпитер" }, { label: "C", text: "Венера" }, { label: "D", text: "Земля" }];
      const who = role === "host" ? "lera" : "me";
      const wrong = step === "wrong";
      return { ...base, hostLine: line(`${who === "me" ? "Саша" : "Лера"}, ваш ответ?`), question: q({ price: 400, stage: "answering", answeringId: who, content, wrongIds: wrong ? ["max"] : [],
        options: opts.map((o) => ({ ...o, wrong: wrong && o.label === "A" ? true : undefined })), answer: hostAnswer(["B"]) }), timer: timer("answer", 30) };
    }
    case "secret": {
      if (step === "give") return { ...base, phase: "secret", chooserId: "me", hostLine: line("Кот в мешке! Саша, кому отдаёте вопрос?"), question: q({ kind: "secret" }), secret: { giverId: role === "host" ? "max" : "me", candidates: ["max", "lera", "dima"], theme: "Кот: животные", price: 300 }, timer: timer("secret", 30) };
      if (step === "price") return { ...base, phase: "secret", hostLine: line("Саша, выберите стоимость вопроса"), question: q({ kind: "secret" }), secret: { giverId: "max", recipientId: "me", candidates: ["me", "lera", "dima"], theme: "Кот: числа", price: 100, priceChoice: { min: 100, max: 500, step: 400 } }, timer: timer("secret", 30) };
      const content = [text("Какое животное говорит «мяу»?")];
      if (step === "answer") return { ...base, hostLine: line("Саша, вопрос для вас (кот в мешке)"), question: q({ kind: "secret", theme: "Кот: животные", soloId: "me", stage: "answering", answeringId: "me", content, answer: hostAnswer(["Кошка"]) }), timer: timer("answer", 30) };
      return { ...base, hostLine: line("Правильный ответ: Кошка"), question: q({ kind: "secret", theme: "Кот: животные", soloId: "me", stage: "reveal", wrongIds: ["me"], content, answer: { text: ["Кошка", "Кот"], content: [] }, lastResult: { playerId: "me", correct: false, delta: -300 } }), timer: timer("reveal", 4) };
    }
    case "forAll": {
      const content = [image(IMG.flag), text("Флаг какой страны на картинке?")];
      const options = step === "options" ? [{ label: "A", text: "Франция" }, { label: "B", text: "Россия" }, { label: "C", text: "Нидерланды" }, { label: "D", text: "Сербия" }] : undefined;
      const who = ["me", "max", "lera", "dima"];
      if (step === "text" || step === "options") return { ...base, hostLine: line("Вопрос для всех: каждый пишет свой ответ"), question: q({ kind: "forAll", content, options, forAll: { who, done: ["max", "lera"] }, answer: hostAnswer(["Россия"]) }), timer: timer("answer", 40) };
      const answers = [
        { id: "me", answer: "Россия" }, { id: "max", answer: "Франция" }, { id: "lera", answer: "Россия" }, { id: "dima", answer: "" },
      ];
      if (step === "judging") return { ...base, hostLine: line("Ведущий проверяет ответы"), question: q({ kind: "forAll", stage: "judging", content, forAll: { who, done: who, answers: role === "host" ? answers : undefined }, answer: hostAnswer(["Россия"]) }) };
      return { ...base, hostLine: line("Правильный ответ: Россия"), question: q({ kind: "forAll", stage: "reveal", content, answer: { text: ["Россия"], content: [] }, forAll: { who, done: who, answers: [
        { id: "me", answer: "Россия", correct: true, delta: 300 }, { id: "max", answer: "Франция", correct: false, delta: -300 }, { id: "lera", answer: "Россия", correct: true, delta: 300 }, { id: "dima", answer: "", correct: false },
      ] } }), timer: timer("reveal", 4) };
    }
    case "stake": {
      if (step === "turn") return { ...base, phase: "stake", hostLine: line("Саша, ваша ставка?"), question: q({ kind: "stake", price: 300 }), stake: { nominal: 300, leaderId: "max", value: 500, turnId: "me", passed: ["dima"], allIn: false, minBid: 600 }, timer: timer("stake", 30) };
      if (step === "allin") return { ...base, phase: "stake", hostLine: line("Саша, ваша ставка?"), question: q({ kind: "stake", price: 300 }), stake: { nominal: 300, leaderId: "max", value: 1200, turnId: "me", passed: ["dima", "lera"], allIn: true, minBid: 1300 }, timer: timer("stake", 30) };
      const content = [text("Какой фильм первым собрал в прокате больше 2 миллиардов долларов?")];
      if (step === "answer") return { ...base, hostLine: line("Саша, вопрос для вас (аукцион)"), question: q({ kind: "stake", theme: "Кино", price: 1500, soloId: "me", stage: "answering", answeringId: "me", content, answer: hostAnswer(["Аватар"]) }), timer: timer("answer", 30) };
      return { ...base, hostLine: line("Правильный ответ: Аватар"), question: q({ kind: "stake", theme: "Кино", price: 1500, soloId: "me", stage: "reveal", content, answer: { text: ["Аватар"], content: [] }, lastResult: { playerId: "me", correct: true, delta: 1500 } }), timer: timer("reveal", 4) };
    }
    case "stakeAll": {
      const who = ["me", "max", "lera"];
      if (step === "bet") return { ...base, phase: "stakeAll", hostLine: line("Ставка для всех! «История». Делайте ставки втайне"), question: q({ kind: "stakeAll", theme: "История" }), stakeAll: { participants: who, done: ["max"], price: 300, theme: "История" }, timer: timer("stake", 30) };
      const content = [text("В каком году Юрий Гагарин полетел в космос?")];
      if (step === "write") return { ...base, hostLine: line("Пишите ответы"), question: q({ kind: "stakeAll", theme: "История", content, forAll: { who, done: ["lera"] }, answer: hostAnswer(["1961"]) }), timer: timer("answer", 40) };
      return { ...base, hostLine: line("Правильный ответ: 1961"), question: q({ kind: "stakeAll", theme: "История", stage: "reveal", content, answer: { text: ["1961"], content: [] }, forAll: { who, done: who, answers: [
        { id: "me", answer: "1961", correct: true, delta: 700, stake: 700 }, { id: "max", answer: "1957", correct: false, delta: -1200, stake: 1200 }, { id: "lera", answer: "1961", correct: true, delta: 300, stake: 300 },
      ] } }), timer: timer("reveal", 4) };
    }
  }
}

const FEED: ChatItem[] = [
  { id: 1, at: Date.now() - 60_000, kind: "ev", tone: "info", text: "Витрина: данные выдуманные, действия никуда не отправляются" },
  { id: 2, at: Date.now() - 30_000, kind: "msg", fromId: "max", name: "Макс", role: "player", text: "Покажи все типы вопросов" },
  { id: 3, at: Date.now() - 10_000, kind: "ev", tone: "bad", text: "Макс ошибается: «Франция» · −300", fix: { playerId: "max", price: 300, delta: -300, correct: false } },
];

export function Showcase() {
  const [kind, setKind] = useState<Kind>("text");
  const [step, setStep] = useState("read");
  const [role, setRole] = useState<"player" | "host">("player");
  const [nonce, setNonce] = useState(0);
  const room = useMemo(() => scene(kind, step, role), [kind, step, role, nonce]);
  useEffect(() => { enterPreview(room, FEED); }, [room]);
  const steps = STEPS[kind];
  return (
    <div className="shell showcase">
      <div className="showcase-bar">
        <b>Витрина</b>
        <div className="seg">{KINDS.map(([k, label]) => <button key={k} aria-pressed={k === kind} onClick={() => { setKind(k); setStep(STEPS[k][0][0]); }}>{label}</button>)}</div>
        <div className="seg">{steps.map(([s, label]) => <button key={s} aria-pressed={s === step} onClick={() => setStep(s)}>{label}</button>)}</div>
        <div className="seg"><button aria-pressed={role === "player"} onClick={() => setRole("player")}>Глазами игрока</button><button aria-pressed={role === "host"} onClick={() => setRole("host")}>Глазами ведущего</button></div>
        <button className="btn sm" onClick={() => setNonce(nonce + 1)}>Повторить шаг</button>
        <button className="btn sm ghost" onClick={() => { location.hash = ""; location.reload(); }}>Выйти из витрины</button>
      </div>
      <RoomScreen onProfile={() => {}} />
    </div>
  );
}
