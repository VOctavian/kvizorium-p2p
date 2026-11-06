import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { openPack, parseContentXml, buildSiq } from "../src/index.ts";

const V4 = `<?xml version="1.0" encoding="utf-8"?>
<package name="Старый пак" version="4" date="01.01.2020" logo="@logo.jpg" xmlns="http://vladimirkhil.com/ygpackage3.0.xsd">
  <info><authors><author>Автор А</author><author>Автор Б</author></authors></info>
  <rounds>
    <round name="1-й раунд">
      <themes>
        <theme name="Природа">
          <questions>
            <question price="100">
              <scenario><atom>Самое большое животное на Земле</atom></scenario>
              <right><answer>Синий кит</answer><answer>Голубой кит</answer></right>
            </question>
            <question price="200">
              <type name="cat"><param name="theme">Сюрприз</param><param name="cost">300</param></type>
              <scenario><atom type="image">@кот в мешке.jpg</atom><atom>Кто на фото?</atom><atom type="marker" /><atom type="image">@ответ.jpg</atom></scenario>
              <right><answer>Кот</answer></right>
            </question>
            <question price="300">
              <type name="auction" />
              <scenario><atom type="voice">@song.mp3</atom></scenario>
              <right><answer>Песня</answer></right>
            </question>
            <question price="400">
              <type name="bagcat"><param name="theme">Любая</param><param name="cost">0</param><param name="self">true</param><param name="knows">after</param></type>
              <scenario><atom>Вопрос</atom></scenario>
              <right><answer>Ответ</answer></right>
            </question>
            <question price="500">
              <type name="sponsored" />
              <scenario><atom>Спонсорский</atom><atom type="say">Ведущий говорит</atom></scenario>
              <right><answer>Да</answer></right>
              <wrong><answer>Нет</answer></wrong>
            </question>
          </questions>
        </theme>
      </themes>
    </round>
    <round name="Финал" type="final">
      <themes><theme name="История"><questions><question price="0"><scenario><atom>Год крещения Руси</atom></scenario><right><answer>988</answer></right></question></questions></theme></themes>
    </round>
  </rounds>
</package>`;

test("format 4: rounds, special types, marker splits answer media", () => {
  const p = parseContentXml(V4);
  assert.equal(p.version, 4);
  assert.equal(p.name, "Старый пак");
  assert.deepEqual(p.authors, ["Автор А", "Автор Б"]);
  assert.equal(p.logo, "logo.jpg");
  assert.equal(p.rounds.length, 2);
  assert.equal(p.rounds[1].type, "final");
  const qs = p.rounds[0].themes[0].questions;
  assert.deepEqual(qs[0].right, ["Синий кит", "Голубой кит"]);
  assert.equal(qs[1].type, "secret");
  assert.equal(qs[1].secretTheme, "Сюрприз");
  assert.equal(qs[1].secretPrice, 300);
  assert.equal(qs[1].selectionMode, "exceptCurrent");
  assert.equal(qs[1].content.length, 2);
  assert.deepEqual(qs[1].content[0], { type: "image", value: "кот в мешке.jpg", isRef: true, placement: "screen", duration: undefined });
  assert.equal(qs[1].answerContent[0].value, "ответ.jpg");
  assert.equal(qs[2].type, "stake");
  assert.equal(qs[2].content[0].type, "audio");
  assert.deepEqual(qs[3].secretPrice, { min: 100, max: 500, step: 400 });
  assert.equal(qs[3].selectionMode, "any");
  assert.equal(qs[4].type, "noRisk");
  assert.equal(qs[4].content[1].type, "say");
  assert.deepEqual(qs[4].wrong, ["Нет"]);
});

const V5 = `<?xml version="1.0" encoding="utf-8"?>
<package name="Новый пак" version="5" xmlns="https://github.com/VladimirKhil/SI/blob/master/assets/siq_5.xsd">
  <info><authors><author>Я</author></authors></info>
  <rounds><round name="Раунд"><themes><theme name="Кино"><questions>
    <question price="100">
      <params>
        <param name="question" type="content">
          <item>Узнайте фильм</item>
          <item type="image" isRef="True">frame.png</item>
          <item type="audio" isRef="True" placement="background" duration="00:00:12">theme.mp3</item>
        </param>
        <param name="answer" type="content"><item type="image" isRef="True">poster.png</item></param>
      </params>
      <right><answer>Матрица</answer></right>
    </question>
    <question price="200" type="secret">
      <params>
        <param name="theme">Тайна</param>
        <param name="price" type="numberSet"><numberSet minimum="100" maximum="500" step="400" /></param>
        <param name="selectionMode">any</param>
        <param name="question" type="content"><item>Сколько?</item></param>
      </params>
      <right><answer>Много</answer></right>
    </question>
    <question price="300" type="stake"><params><param name="question" type="content"><item>Ставки</item></param></params><right><answer>Да</answer></right></question>
    <question price="400" type="noRisk"><params><param name="question" type="content"><item>Без риска</item></param></params><right><answer>Да</answer></right></question>
  </questions></theme></themes></round></rounds>
</package>`;

test("format 5: params, items, placement, numberSet", () => {
  const p = parseContentXml(V5);
  assert.equal(p.version, 5);
  const [q1, q2, q3, q4] = p.rounds[0].themes[0].questions;
  assert.equal(q1.content.length, 3);
  assert.equal(q1.content[2].placement, "background");
  assert.equal(q1.content[2].duration, 12);
  assert.equal(q1.answerContent[0].value, "poster.png");
  assert.equal(q2.type, "secret");
  assert.equal(q2.secretTheme, "Тайна");
  assert.deepEqual(q2.secretPrice, { min: 100, max: 500, step: 400 });
  assert.equal(q2.selectionMode, "any");
  assert.equal(q3.type, "stake");
  assert.equal(q4.type, "noRisk");
});

test("archive: finds escaped media names and reports stats", async () => {
  const zip = new JSZip();
  zip.file("content.xml", V4);
  zip.file("Images/" + encodeURI("кот в мешке.jpg"), "x");
  zip.file("Images/%D0%BE%D1%82%D0%B2%D0%B5%D1%82.jpg", "y");
  zip.file("Audio/song.mp3", "z");
  const opened = await openPack(await zip.generateAsync({ type: "uint8array" }));
  assert.equal(opened.stats.questions, 6);
  assert.equal(opened.stats.mediaFiles, 3);
  assert.ok(opened.resolve("кот в мешке.jpg", "image"));
  assert.ok(opened.resolve("@ответ.jpg"));
  assert.equal(opened.resolve("song.mp3", "audio")?.kind, "audio");
  assert.equal(opened.resolve("missing.png"), undefined);
  assert.equal(new TextDecoder().decode(await opened.read(opened.resolve("song.mp3")!.path)), "z");
});

test("round trip: buildSiq output opens with openPack", async () => {
  const bytes = await buildSiq({
    name: "Тест", authors: ["Я"],
    rounds: [{ name: "Р1", themes: [{ name: "Т", questions: [
      { price: 100, question: ["Вопрос", { type: "image", file: "моя картинка.svg" }], answer: ["Ответ"] },
      { price: 200, type: "secret", secretTheme: "Кот", secretPrice: 300, question: ["?"], answer: ["!"] },
    ] }] }],
    files: { "Images/моя картинка.svg": "<svg/>" },
  });
  const o = await openPack(bytes);
  assert.equal(o.pack.version, 5);
  const q = o.pack.rounds[0].themes[0].questions;
  assert.equal(q[0].content[1].value, "моя картинка.svg");
  assert.ok(o.resolve(q[0].content[1].value, "image"));
  assert.equal(q[1].secretPrice, 300);
});

test("garbage input gives a readable error", async () => {
  await assert.rejects(openPack(new Uint8Array([1, 2, 3])), /не zip-архив/);
});

test("bundled test packs: every question type in format 5 and format 4", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(import.meta.dirname, "..", "..", "..", "packs");
  const all = await openPack(readFileSync(join(dir, "test-all-types.siq")));
  const types = all.pack.rounds[0].themes.flatMap((t) => t.questions.map((q) => q.type));
  for (const t of ["simple", "stake", "secret", "secretPublicPrice", "secretNoQuestion", "noRisk", "forAll"]) assert.ok(types.includes(t as never), `нет типа ${t}`);
  const qs = all.pack.rounds[0].themes.flatMap((t) => t.questions);
  for (const q of qs) for (const it of [...q.content, ...q.answerContent]) if (it.isRef) assert.ok(all.resolve(it.value, it.type as never), `нет файла ${it.value}`);
  assert.ok(qs.some((q) => q.content.some((c) => c.type === "say")), "реплика ведущего");
  assert.deepEqual(qs.find((q) => q.answerOptions)?.answerOptions?.map((o) => o.label), ["A", "B", "C", "D"]);
  assert.equal(all.pack.rounds[1].type, "final");

  const v4 = await openPack(readFileSync(join(dir, "test-format4.siq")));
  assert.equal(v4.pack.version, 4);
  const t4 = v4.pack.rounds[0].themes[1].questions.map((q) => q.type);
  assert.deepEqual(t4, ["secret", "secret", "stake", "noRisk"]);
  const marker = v4.pack.rounds[0].themes[0].questions[3];
  assert.equal(marker.answerContent[0].value, "треугольник.svg");
  assert.ok(v4.resolve("пять нот.wav", "audio"));
});

test("SIGame type names: withButton, forYourself, stakeAll, empty type, answerType/answerDeviation", () => {
  const q = (type: string, extra = "") => `<question price="100"${type ? ` type="${type}"` : ""}><params><param name="question" type="content"><item>?</item></param>${extra}</params><right><answer>1</answer></right></question>`;
  const xml = `<?xml version="1.0"?><package name="T" version="5"><rounds><round name="R"><themes><theme name="T"><questions>
    ${q("withButton")}${q("forYourself")}${q("stakeAll")}${q("")}${q("simple", `<param name="answerType">number</param><param name="answerDeviation">5</param>`)}
  </questions></theme></themes></round></rounds></package>`;
  const qs = parseContentXml(xml).rounds[0].themes[0].questions;
  assert.deepEqual(qs.map((x) => x.type), ["simple", "noRisk", "stakeAll", "simple", "simple"]);
  assert.equal(qs[4].answerType, "number");
  assert.equal(qs[4].answerDeviation, 5);
});
