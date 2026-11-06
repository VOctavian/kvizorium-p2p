/** Builds packs/demo.siq — a small original pack that exercises every question type. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import JSZip from "jszip";
import { join } from "node:path";
import { buildSiq, type BuildPack } from "../packages/siq/src/index.ts";

const svg = (body: string, bg: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="${bg}"/>${body}</svg>`;

const files: Record<string, string> = {
  "Images/логотип.svg": svg(`<circle cx="320" cy="180" r="120" fill="#8a7bff"/><circle cx="270" cy="150" r="70" fill="#43f0c4" opacity=".8"/><circle cx="370" cy="210" r="60" fill="#ff74b3" opacity=".8"/>`, "#0f1638"),
  "Images/марс.svg": svg(`<defs><radialGradient id="g" cx=".35" cy=".3"><stop offset="0" stop-color="#ffb38a"/><stop offset=".55" stop-color="#c4552d"/><stop offset="1" stop-color="#5e1c0f"/></radialGradient></defs><circle cx="320" cy="180" r="130" fill="url(#g)"/><path d="M250 210 l40-60 40 60z" fill="#7a2a14" opacity=".7"/>`, "#0c1030"),
  "Images/флаг.svg": svg(`<rect y="0" width="640" height="120" fill="#ffffff"/><rect y="120" width="640" height="120" fill="#0039a6"/><rect y="240" width="640" height="120" fill="#d52b1e"/>`, "#000"),
  "Images/ответ-олимп.svg": svg(`<path d="M120 300 L320 90 L520 300 Z" fill="#c4552d"/><text x="320" y="340" font-size="36" text-anchor="middle" fill="#fff" font-family="sans-serif">Олимп, 21,9 км</text>`, "#1a0f2a"),
};

const pack: BuildPack = {
  name: "Сборная солянка (демо)",
  authors: ["Квизориум"],
  logo: "логотип.svg",
  files,
  rounds: [
    {
      name: "Разминка",
      themes: [
        { name: "Кино", questions: [
          { price: 100, question: ["Как зовут робота-мусорщика из мультфильма Pixar 2008 года?"], answer: ["ВАЛЛ-И", "Валли", "WALL-E"] },
          { price: 200, question: ["Кто сыграл Нео в «Матрице»?"], answer: ["Киану Ривз", "Ривз"] },
          { price: 300, type: "stake", question: ["Какой фильм первым собрал в прокате больше 2 миллиардов долларов?"], answer: ["Аватар"] },
          { price: 400, question: ["Кто снял «Сталкера» в 1979 году?"], answer: ["Андрей Тарковский", "Тарковский"] },
          { price: 500, question: ["Из какого вымышленного металла сделан щит Капитана Америка?"], answer: ["Вибраниум"] },
        ] },
        { name: "Космос", questions: [
          { price: 100, question: ["Какая планета ближе всех к Солнцу?"], answer: ["Меркурий"] },
          { price: 200, question: ["Как звали первую собаку, побывавшую на орбите?"], answer: ["Лайка"] },
          { price: 300, question: [{ type: "image", file: "марс.svg" }, "Самый высокий вулкан Солнечной системы находится на этой планете. Как он называется?"], answer: ["Олимп"], answerMedia: [{ type: "image", file: "ответ-олимп.svg" }] },
          { price: 400, question: ["Как называется граница чёрной дыры, из-за которой ничто не возвращается?"], answer: ["Горизонт событий"] },
          { price: 500, type: "noRisk", question: ["Сколько примерно минут свет летит от Солнца до Земли?"], answer: ["8", "Восемь", "Около 8 минут"] },
        ] },
        { name: "Видеоигры", questions: [
          { price: 100, question: ["Как зовут водопроводчика в красной кепке из игр Nintendo?"], answer: ["Марио"] },
          { price: 200, question: ["Какую игру Алексей Пажитнов написал в 1984 году?"], answer: ["Тетрис"] },
          { price: 300, type: "secret", secretTheme: "Кот в мешке: флаги", secretPrice: 300, question: [{ type: "image", file: "флаг.svg" }, "Флаг какой страны на картинке?"], answer: ["Россия", "России"] },
          { price: 400, question: ["Какая польская студия делает серию «Ведьмак»?"], answer: ["CD Projekt Red", "CD Projekt"] },
          { price: 500, question: ["В какой игре 1980 года жёлтый круг ест точки в лабиринте?"], answer: ["Pac-Man", "Пакман"] },
        ] },
      ],
    },
    {
      name: "Второй раунд",
      themes: [
        { name: "Еда мира", questions: [
          { price: 200, question: ["Из какой страны родом паэлья?"], answer: ["Испания"] },
          { price: 400, question: ["Как называется японский суп на пасте из соевых бобов?"], answer: ["Мисо"] },
          { price: 600, type: "stake", question: ["Какой сыр кладут в греческий салат?"], answer: ["Фета"] },
          { price: 800, question: ["Как называется грузинская лепёшка-лодочка с сыром и яйцом?"], answer: ["Хачапури по-аджарски", "Аджарский хачапури", "Хачапури"] },
          { price: 1000, question: ["Какая специя самая дорогая в мире по весу?"], answer: ["Шафран"] },
        ] },
        { name: "Языки", questions: [
          { price: 200, question: ["Сколько букв в русском алфавите?"], answer: ["33", "Тридцать три"] },
          { price: 400, question: ["Какой язык родной для наибольшего числа людей?"], answer: ["Китайский", "Мандаринский"] },
          { price: 600, type: "secret", secretTheme: "Кот в мешке: перевод", secretPrice: { min: 200, max: 1000, step: 800 }, question: ["Что значит японское «аригато»?"], answer: ["Спасибо"] },
          { price: 800, question: ["На каком языке написан «Дон Кихот»?"], answer: ["Испанский"] },
          { price: 1000, question: ["Как называется язык, который придумал Людвик Заменгоф?"], answer: ["Эсперанто"] },
        ] },
      ],
    },
    {
      name: "Финал",
      final: true,
      themes: [
        { name: "История", questions: [{ price: 0, question: ["В каком году Юрий Гагарин полетел в космос?"], answer: ["1961"] }] },
        { name: "География", questions: [{ price: 0, question: ["Какая река самая длинная в Европе?"], answer: ["Волга"] }] },
        { name: "Литература", questions: [{ price: 0, question: ["Кто написал «Мастера и Маргариту»?"], answer: ["Булгаков", "Михаил Булгаков"] }] },
      ],
    },
  ],
};

const outDir = join(import.meta.dirname, "..", "packs");
mkdirSync(outDir, { recursive: true });
const bytes = await buildSiq(pack);
writeFileSync(join(outDir, "demo.siq"), bytes);
console.log(`packs/demo.siq: ${(bytes.length / 1024).toFixed(1)} КБ`);

/* ===================== Test packs: every question type, both formats ===================== */

/** A short tune as 16-bit mono WAV, so the pack has real audio without external files. */
function melodyWav(notes: number[], noteSec = 0.32, gapSec = 0.1): Uint8Array {
  const rate = 16000;
  const samples: number[] = [];
  for (const f of notes) {
    const n = Math.round(rate * noteSec);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 400) * Math.min(1, (n - i) / 1600);
      samples.push(Math.sin((2 * Math.PI * f * i) / rate) * 0.45 * env + Math.sin((4 * Math.PI * f * i) / rate) * 0.1 * env);
    }
    for (let i = 0; i < rate * gapSec; i++) samples.push(0);
  }
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2));
  return new Uint8Array(buf);
}

const mediaDir = join(import.meta.dirname, "media");
const video = existsSync(join(mediaDir, "planets.webm")) ? readFileSync(join(mediaDir, "planets.webm")) : undefined;
if (!video) console.log("нет tools/media/planets.webm — запустите: npx electron tools/make-video.cjs");

const testFiles: Record<string, Uint8Array | string> = {
  "Images/логотип теста.svg": svg(`<rect x="170" y="80" width="300" height="200" rx="30" fill="#43f0c4"/><text x="320" y="205" font-size="90" text-anchor="middle" font-family="sans-serif" font-weight="800" fill="#0f1638">ТЕСТ</text>`, "#0f1638"),
  "Images/марс.svg": files["Images/марс.svg"],
  "Images/флаг.svg": files["Images/флаг.svg"],
  "Images/треугольник.svg": svg(`<path d="M320 60 L520 300 L120 300 Z" fill="#ff74b3"/>`, "#1a0f2a"),
  "Audio/пять нот.wav": melodyWav([523, 587, 659, 698, 784]),
  ...(video ? { "Video/планеты.webm": new Uint8Array(video) } : {}),
};

const allTypes: BuildPack = {
  name: "Проверка всех типов вопросов",
  authors: ["Квизориум"],
  logo: "логотип теста.svg",
  files: testFiles,
  rounds: [
    {
      name: "Типы вопросов",
      themes: [
        { name: "Обычные и медиа", questions: [
          { price: 100, question: ["Обычный текстовый вопрос. Сколько будет 2 + 2?"], answer: ["4", "четыре"] },
          { price: 200, question: [{ type: "image", file: "марс.svg" }, "Вопрос с картинкой. Какая это планета?"], answer: ["Марс"] },
          { price: 300, question: [{ type: "audio", file: "пять нот.wav" }, "Вопрос со звуком. Сколько нот прозвучало?"], answer: ["5", "пять"] },
          video
            ? { price: 400, question: [{ type: "video", file: "планеты.webm" }, "Вопрос с видео. Сколько планет кружит вокруг звезды?"], answer: ["3", "три"] }
            : { price: 400, question: ["(Видео не собрано.) Сколько планет в Солнечной системе?"], answer: ["8", "восемь"] },
          { price: 500, question: [{ say: "Сейчас будет вопрос, а в ответе покажем картинку." }, "Реплика ведущего и медиа в ответе. Какую фигуру покажут в ответе?"], answer: ["Треугольник"], answerMedia: [{ type: "image", file: "треугольник.svg" }] },
        ] },
        { name: "Ставки и коты", questions: [
          { price: 100, type: "stake", question: ["Аукцион. Столица Франции?"], answer: ["Париж"] },
          { price: 200, type: "secret", secretTheme: "Кот: животные", secretPrice: 300, selectionMode: "exceptCurrent", question: ["Кот в мешке (цена 300, себе оставить нельзя). Какое животное говорит «мяу»?"], answer: ["Кошка", "Кот"] },
          { price: 300, type: "secret", secretTheme: "Кот: числа", secretPrice: { min: 100, max: 500, step: 400 }, selectionMode: "any", question: ["Кот в мешке с выбором цены 100 или 500, можно оставить себе. Сколько дней в неделе?"], answer: ["7", "семь"] },
          { price: 400, type: "secretPublicPrice", secretTheme: "Кот с открытой ценой", secretPrice: 400, question: ["Кот в мешке с открытой ценой. Какого цвета ясное небо днём?"], answer: ["Голубое", "Синее", "Голубой"] },
          { price: 500, type: "secretNoQuestion", secretTheme: "Кот без вопроса", secretPrice: 500, question: ["Этот текст не показывается: получатель сразу забирает 500."], answer: ["—"] },
        ] },
        { name: "Без риска, для всех, варианты", questions: [
          { price: 100, type: "noRisk", question: ["Вопрос без риска: верно — двойная цена, ошибка — без штрафа. Сколько ног у паука?"], answer: ["8", "восемь"] },
          { price: 200, type: "forAll", question: ["Вопрос для всех: каждый пишет ответ. Столица России?"], answer: ["Москва"] },
          { price: 300, type: "forAll", question: [{ type: "image", file: "флаг.svg" }, "Вопрос для всех с картинкой. Флаг какой страны?"], answer: ["Россия"] },
          { price: 400, question: ["Вопрос с вариантами ответа. Какая планета самая большая?"], answer: ["B"], options: [{ label: "A", text: "Марс" }, { label: "B", text: "Юпитер" }, { label: "C", text: "Венера" }, { label: "D", text: "Земля" }] },
          { price: 500, question: ["Длинный вопрос, чтобы проверить постепенный показ текста. Включите в настройках «Текст вопроса: постепенно» и смотрите, как он появляется. Этот город на Неве основал Пётр Первый в 1703 году. Как он называется?"], answer: ["Санкт-Петербург", "Петербург", "Питер"], wrong: ["Ленинград"] },
        ] },
        { name: "Ставки для всех и числа", questions: [
          { price: 200, type: "stakeAll", question: ["Ставка для всех: каждый со счётом больше нуля тайно ставит. В каком году основана Москва?"], answer: ["1147"] },
          { price: 300, type: "forAll", question: ["Вопрос для всех с вариантами. Сколько континентов на Земле?"], answer: ["C"], options: [{ label: "A", text: "Пять" }, { label: "B", text: "Шесть" }, { label: "C", text: "Семь" }, { label: "D", text: "Восемь" }] },
          { price: 400, question: ["Числовой ответ с погрешностью ±10. Сколько метров в километре?"], answer: ["1000"], answerType: "number", answerDeviation: 10 },
        ] },
      ],
    },
    {
      name: "Финал",
      final: true,
      themes: [
        { name: "История", questions: [{ price: 0, question: ["В каком году Юрий Гагарин полетел в космос?"], answer: ["1961"] }] },
        { name: "География", questions: [{ price: 0, question: ["Какая река самая длинная в Европе?"], answer: ["Волга"] }] },
        { name: "Литература", questions: [{ price: 0, question: ["Кто написал «Мастера и Маргариту»?"], answer: ["Булгаков", "Михаил Булгаков"] }] },
      ],
    },
  ],
};
const allBytes = await buildSiq(allTypes);
writeFileSync(join(outDir, "test-all-types.siq"), allBytes);
console.log(`packs/test-all-types.siq: ${(allBytes.length / 1024).toFixed(1)} КБ`);

/* Format 4 (older SIGame packs): atoms, marker, type names cat / bagcat / auction / sponsored. */
const esc4 = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const q4 = (price: number, atoms: string, right: string[], type = "") =>
  `<question price="${price}">${type}<scenario>${atoms}</scenario><right>${right.map((r) => `<answer>${esc4(r)}</answer>`).join("")}</right></question>`;
const v4Xml = `<?xml version="1.0" encoding="utf-8"?>
<package name="Проверка формата 4" version="4" date="05.11.2026" logo="@логотип теста.svg" xmlns="http://vladimirkhil.com/ygpackage3.0.xsd">
<info><authors><author>Квизориум</author></authors></info>
<rounds>
<round name="Старый формат"><themes>
<theme name="Атомы"><questions>
${q4(100, `<atom>Простой вопрос формата 4. Сколько будет 3 + 3?</atom>`, ["6", "шесть"])}
${q4(200, `<atom type="image">@марс.svg</atom><atom>Картинка через атом image. Что это за планета?</atom>`, ["Марс"])}
${q4(300, `<atom type="voice">@пять нот.wav</atom><atom>Звук через атом voice. Сколько нот?</atom>`, ["5", "пять"])}
${q4(400, `<atom type="say">Ведущий читает это вслух.</atom><atom>Атом say и маркер. Какая фигура будет в ответе?</atom><atom type="marker" /><atom type="image">@треугольник.svg</atom>`, ["Треугольник"])}
</questions></theme>
<theme name="Особые типы"><questions>
${q4(100, `<atom>Кот (cat) за 300. Какое животное говорит «гав»?</atom>`, ["Собака", "Пёс"], `<type name="cat"><param name="theme">Кот: животные</param><param name="cost">300</param></type>`)}
${q4(200, `<atom>Кот (bagcat) с ценой на выбор, можно себе. Сколько месяцев в году?</atom>`, ["12", "двенадцать"], `<type name="bagcat"><param name="theme">Кот: календарь</param><param name="cost">0</param><param name="self">true</param><param name="knows">after</param></type>`)}
${q4(300, `<atom>Аукцион (auction). Столица Италии?</atom>`, ["Рим"], `<type name="auction" />`)}
${q4(400, `<atom>Вопрос от спонсора (sponsored). Сколько цветов у радуги?</atom>`, ["7", "семь"], `<type name="sponsored" />`)}
</questions></theme>
</themes></round>
<round name="Финал" type="final"><themes>
<theme name="Химия"><questions>${q4(0, `<atom>Химический символ золота?</atom>`, ["Au"])}</questions></theme>
<theme name="Музыка"><questions>${q4(0, `<atom>Сколько линий в нотном стане?</atom>`, ["5", "пять"])}</questions></theme>
</themes></round>
</rounds></package>`;
const zip4 = new JSZip();
zip4.file("content.xml", v4Xml);
for (const [path, data] of Object.entries(testFiles)) {
  if (path.startsWith("Video/")) continue;
  const slash = path.indexOf("/");
  zip4.file(path.slice(0, slash + 1) + encodeURI(path.slice(slash + 1)), data);
}
const v4Bytes = await zip4.generateAsync({ type: "uint8array", compression: "DEFLATE" });
writeFileSync(join(outDir, "test-format4.siq"), v4Bytes);
console.log(`packs/test-format4.siq: ${(v4Bytes.length / 1024).toFixed(1)} КБ`);

/* Wide board: 15 questions per theme, to check that the board fits the screen without scrolling. */
const wideThemes = ["Числа", "Буквы", "Цвета", "Страны", "Животные", "Планеты"];
const wide: BuildPack = {
  name: "Широкое табло: 15 в ряд",
  authors: ["Квизориум"],
  rounds: [
    {
      name: "Пятнадцать вопросов в теме",
      themes: wideThemes.map((name) => ({
        name,
        questions: Array.from({ length: 15 }, (_, i) => ({ price: (i + 1) * 100, question: [`${name}: вопрос ${i + 1}. Сколько будет ${i + 1} + 1?`], answer: [String(i + 2)] })),
      })),
    },
    {
      name: "Обычный раунд",
      themes: ["Разминка", "Логика", "Память"].map((name) => ({
        name,
        questions: [200, 400, 600, 800, 1000].map((price, i) => ({ price, question: [`${name}: сколько будет ${i + 2} × 2?`], answer: [String((i + 2) * 2)] })),
      })),
    },
    { name: "Финал", final: true, themes: [{ name: "Арифметика", questions: [{ price: 0, question: ["Сколько будет 12 × 12?"], answer: ["144"] }] }] },
  ],
};
const wideBytes = await buildSiq(wide);
writeFileSync(join(outDir, "test-wide.siq"), wideBytes);
console.log(`packs/test-wide.siq: ${(wideBytes.length / 1024).toFixed(1)} КБ`);

/* 15 categories, one of them 150 characters long: theme names must shrink and wrap to fit. */
const longName = "Очень длинное название категории, чтобы проверить, как табло уменьшает шрифт и переносит текст на несколько строк, когда места мало: история";
const long150 = (longName + " ".repeat(150)).slice(0, 150).replace(/\s+$/, "").padEnd(150, "!");
const manyNames = [
  "Кино", long150, "Наука и техника", "Видеоигры", "Еда мира", "Языки", "Космос", "Музыка 90-х и нулевых",
  "Спорт", "География без карты", "Литература", "Мемы", "Животные", "Изобретения XX века", "Живопись",
];
const many: BuildPack = {
  name: "Пятнадцать категорий",
  authors: ["Квизориум"],
  rounds: [{
    name: "15 тем",
    themes: manyNames.map((name, ti) => ({
      name,
      questions: [100, 200, 300, 400, 500].map((price, i) => ({ price, question: [`Тема ${ti + 1}, вопрос ${i + 1}: сколько будет ${ti + 1} + ${i + 1}?`], answer: [String(ti + i + 2)] })),
    })),
  }, {
    name: "15 тем по 15 вопросов",
    themes: manyNames.map((name, ti) => ({
      name,
      questions: Array.from({ length: 15 }, (_, i) => ({ price: (i + 1) * 100, question: [`Тема ${ti + 1}, вопрос ${i + 1}`], answer: ["да"] })),
    })),
  }],
};
if (long150.length !== 150) throw new Error(`длинное название ${long150.length} символов`);
const manyBytes = await buildSiq(many);
writeFileSync(join(outDir, "test-15-themes.siq"), manyBytes);
console.log(`packs/test-15-themes.siq: ${(manyBytes.length / 1024).toFixed(1)} КБ, длинная тема ${long150.length} символов`);

/* Two final rounds (setting "one final / all finals"), pictures one after another, a final with sound and wrong answers. */
const finals: BuildPack = {
  name: "Два финала",
  authors: ["Квизориум"],
  files: testFiles,
  rounds: [{
    name: "Разогрев",
    themes: [{ name: "Кадры", questions: [
      { price: 100, question: ["Угадайте по двум кадрам: что их объединяет?", { type: "image", file: "марс.svg" }, { type: "image", file: "треугольник.svg" }], answer: ["Красный цвет", "красный"] },
      { price: 200, question: ["Сколько будет 2 + 2?"], answer: ["4", "четыре"] },
    ] }],
  }, {
    name: "Первый финал",
    final: true,
    themes: [
      { name: "Книги | Легко", questions: [{ price: 0, question: ["Кто написал «Евгения Онегина»?"], answer: ["Пушкин", "Александр Пушкин"] }] },
      { name: "Музыка | Средне", questions: [{ price: 0, question: [{ type: "audio", file: "пять нот.wav" }], answer: ["Гамма до мажор"], wrong: ["Гамма ре минор", "Собачий вальс"] }] },
      { name: "Космос | Легко", questions: [{ price: 0, question: ["Назовите четыре планеты земной группы"], answer: ["Меркурий, Венера, Земля, Марс"] }] },
    ],
  }, {
    name: "Второй финал",
    final: true,
    themes: [
      { name: "Флаги", questions: [{ price: 0, question: [{ type: "image", file: "флаг.svg" }, "Чей это флаг?"], answer: ["Россия"] }] },
      { name: "Числа", questions: [{ price: 0, question: ["Сколько секунд в часе?"], answer: ["3600"] }] },
    ],
  }],
};
const finalsBytes = await buildSiq(finals);
writeFileSync(join(outDir, "test-finals.siq"), finalsBytes);
console.log(`packs/test-finals.siq: ${(finalsBytes.length / 1024).toFixed(1)} КБ`);
