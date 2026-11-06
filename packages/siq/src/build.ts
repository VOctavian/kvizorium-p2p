import JSZip from "jszip";

/** Minimal description used to write a pack in SIQ format 5 (the format current SIGame reads). */
export interface BuildPack {
  name: string;
  authors: string[];
  logo?: string;
  rounds: {
    name: string;
    final?: boolean;
    themes: {
      name: string;
      questions: {
        price: number;
        type?: "simple" | "stake" | "stakeAll" | "secret" | "secretPublicPrice" | "secretNoQuestion" | "noRisk" | "forAll";
        /** Strings are on-screen text; { say } is what the host reads aloud. */
        question: (string | { say: string } | { type: "image" | "audio" | "video"; file: string; background?: boolean })[];
        answer: string[];
        wrong?: string[];
        answerMedia?: { type: "image" | "audio" | "video"; file: string }[];
        secretTheme?: string;
        secretPrice?: number | { min: number; max: number; step: number };
        /** For cats in the bag: may the chooser keep the question? */
        selectionMode?: "any" | "exceptCurrent";
        /** "Select" answer type: labelled options, the right answer is a label. */
        options?: { label: string; text: string }[];
        /** "number" answers may be off by `answerDeviation`; "point": the answer is "x,y,height/width" on the picture. */
        answerType?: "text" | "number" | "point";
        answerDeviation?: number;
      }[];
    }[];
  }[];
  /** Files to put in Images/, Audio/, Video/ keyed by "Images/name.png". */
  files?: Record<string, Uint8Array | string>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function contentXmlV5(p: BuildPack): string {
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="utf-8"?>`);
  out.push(`<package name="${esc(p.name)}" version="5" id="${crypto.randomUUID()}" date="${new Date().toLocaleDateString("ru-RU")}"${p.logo ? ` logo="@${esc(p.logo)}"` : ""} xmlns="https://github.com/VladimirKhil/SI/blob/master/assets/siq_5.xsd">`);
  out.push(`<info><authors>${p.authors.map((a) => `<author>${esc(a)}</author>`).join("")}</authors></info>`);
  out.push(`<rounds>`);
  for (const r of p.rounds) {
    out.push(`<round name="${esc(r.name)}"${r.final ? ` type="final"` : ""}><themes>`);
    for (const t of r.themes) {
      out.push(`<theme name="${esc(t.name)}"><questions>`);
      for (const q of t.questions) {
        out.push(`<question price="${q.price}"${q.type && q.type !== "simple" ? ` type="${q.type}"` : ""}><params>`);
        if (q.secretTheme) out.push(`<param name="theme">${esc(q.secretTheme)}</param>`);
        if (q.secretPrice != null) {
          const sp = typeof q.secretPrice === "number" ? { min: q.secretPrice, max: q.secretPrice, step: 0 } : q.secretPrice;
          out.push(`<param name="price" type="numberSet"><numberSet minimum="${sp.min}" maximum="${sp.max}" step="${sp.step}" /></param>`);
        }
        if (q.type?.startsWith("secret")) out.push(`<param name="selectionMode">${q.selectionMode ?? "exceptCurrent"}</param>`);
        if (q.answerType && !q.options) out.push(`<param name="answerType">${q.answerType}</param>`);
        if (q.answerDeviation != null) out.push(`<param name="answerDeviation">${q.answerDeviation}</param>`);
        if (q.options) {
          out.push(`<param name="answerType">select</param><param name="answerOptions" type="group">`);
          for (const o of q.options) out.push(`<param name="${esc(o.label)}" type="content"><item>${esc(o.text)}</item></param>`);
          out.push(`</param>`);
        }
        out.push(`<param name="question" type="content">`);
        for (const it of q.question) {
          if (typeof it === "string") out.push(`<item>${esc(it)}</item>`);
          else if ("say" in it) out.push(`<item placement="replic">${esc(it.say)}</item>`);
          else out.push(`<item type="${it.type}" isRef="True"${it.background ? ` placement="background"` : ""}>${esc(it.file)}</item>`);
        }
        out.push(`</param>`);
        if (q.answerMedia?.length) {
          out.push(`<param name="answer" type="content">`);
          for (const it of q.answerMedia) out.push(`<item type="${it.type}" isRef="True">${esc(it.file)}</item>`);
          out.push(`</param>`);
        }
        out.push(`</params><right>${q.answer.map((a) => `<answer>${esc(a)}</answer>`).join("")}</right>${q.wrong?.length ? `<wrong>${q.wrong.map((a) => `<answer>${esc(a)}</answer>`).join("")}</wrong>` : ""}</question>`);
      }
      out.push(`</questions></theme>`);
    }
    out.push(`</themes></round>`);
  }
  out.push(`</rounds></package>`);
  return out.join("\n");
}

export async function buildSiq(p: BuildPack): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("content.xml", contentXmlV5(p));
  for (const [path, data] of Object.entries(p.files ?? {})) {
    const slash = path.indexOf("/");
    // SIGame stores media names URI-escaped inside the archive.
    zip.file(path.slice(0, slash + 1) + encodeURI(path.slice(slash + 1)), data);
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
