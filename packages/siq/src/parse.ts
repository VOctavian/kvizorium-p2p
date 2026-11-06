import { XMLParser } from "fast-xml-parser";
import type { ContentItem, ItemType, Pack, Placement, PriceRange, Question, QuestionType, Round, Theme } from "./types.ts";

/* fast-xml-parser gives us loosely typed nodes. */
type Node = Record<string, any>;

const ARRAY_TAGS = new Set(["author", "round", "theme", "question", "atom", "item", "param", "answer", "comment", "source"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const arr = <T = Node>(v: unknown): T[] => (v == null ? [] : Array.isArray(v) ? (v as T[]) : [v as T]);
const text = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(text).join("\n");
  const t = (v as Node)["#text"];
  return t == null ? "" : String(t);
};
const attr = (n: unknown, name: string): string | undefined => {
  if (n == null || typeof n !== "object") return undefined;
  const v = (n as Node)["@" + name];
  return v == null ? undefined : String(v);
};
const num = (v: string | undefined, fallback = 0): number => {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v: string | undefined) => v != null && /^true$/i.test(v.trim());

/** "00:00:12" or "12" → seconds */
function parseDuration(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const parts = v.split(":").map(Number);
  if (parts.some((x) => !Number.isFinite(x))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0) || undefined;
}

function authors(info: Node | undefined): string[] {
  return arr(info?.authors?.author).map(text).filter(Boolean);
}

/* ---------- Format 5 ---------- */

function itemsV5(paramNode: Node | undefined): ContentItem[] {
  return arr(paramNode?.item).map((it) => {
    const rawType = (attr(it, "type") ?? "text").toLowerCase();
    let type: ItemType = rawType === "image" || rawType === "audio" || rawType === "video" || rawType === "html" ? rawType : "text";
    const placement = (attr(it, "placement") as Placement | undefined) ?? (type === "audio" ? "background" : "screen");
    if (type === "text" && placement === "replic") type = "say";
    return {
      type,
      value: text(it),
      isRef: bool(attr(it, "isRef")),
      placement,
      duration: parseDuration(attr(it, "duration")),
      waitForFinish: attr(it, "waitForFinish") == null ? undefined : bool(attr(it, "waitForFinish")),
    };
  });
}

function priceV5(p: Node | undefined): PriceRange | number | undefined {
  if (!p) return undefined;
  const ns = p.numberSet;
  if (ns) {
    const min = num(attr(ns, "minimum"));
    const max = num(attr(ns, "maximum"), min);
    const step = num(attr(ns, "step"), 0);
    if (min === max) return min;
    return { min, max, step: step || max - min };
  }
  const t = text(p);
  return t ? num(t) : undefined;
}

/** SIGame QuestionTypes (SIPackages/Core/QuestionTypes.cs), lower-cased. */
const V5_TYPES: Record<string, QuestionType> = {
  "": "simple",
  simple: "simple",
  withbutton: "simple",
  stake: "stake",
  stakeall: "stakeAll",
  foryourself: "noRisk",
  secret: "secret",
  secretpublicprice: "secretPublicPrice",
  secretnoquestion: "secretNoQuestion",
  norisk: "noRisk",
  forall: "forAll",
};

function questionV5(q: Node, roundPrices: number[]): Question {
  const params = new Map<string, Node>();
  for (const p of arr(q.params?.param)) params.set(attr(p, "name") ?? "", p);
  const type = V5_TYPES[(attr(q, "type") ?? "simple").toLowerCase()] ?? "simple";
  const optionsNode = params.get("answerOptions");
  const answerOptions = optionsNode
    ? arr(optionsNode.param).map((o) => ({ label: attr(o, "name") ?? "", content: itemsV5(o) }))
    : undefined;
  let secretPrice = priceV5(params.get("price"));
  // A range of 0..0 means "min or max of the round", like format 4 bagcat.
  if (secretPrice === 0 && roundPrices.length) secretPrice = rangeOfRound(roundPrices);
  return {
    price: num(attr(q, "price")),
    type,
    content: itemsV5(params.get("question")),
    answerContent: itemsV5(params.get("answer")),
    right: arr(q.right?.answer).map(text).filter(Boolean),
    wrong: arr(q.wrong?.answer).map(text).filter(Boolean),
    comment: arr(q.info?.comments).map(text).join("\n") || undefined,
    secretTheme: params.has("theme") ? text(params.get("theme")) : undefined,
    secretPrice,
    selectionMode: (text(params.get("selectionMode")) as Question["selectionMode"]) || undefined,
    answerOptions: answerOptions?.length ? answerOptions : undefined,
    answerType: text(params.get("answerType")) || undefined,
    answerDeviation: params.has("answerDeviation") ? num(text(params.get("answerDeviation"))) : undefined,
  };
}

/* ---------- Format 4 ---------- */

function atomItem(a: Node | string): ContentItem & { marker?: boolean } {
  const rawType = (attr(a, "type") ?? "text").toLowerCase();
  const value = typeof a === "string" ? a : text(a);
  if (rawType === "marker") return { type: "text", value: "", isRef: false, placement: "screen", marker: true };
  const map: Record<string, ItemType> = { text: "text", say: "say", image: "image", voice: "audio", audio: "audio", video: "video", html: "html" };
  const type = map[rawType] ?? "text";
  const isRef = value.startsWith("@");
  return {
    type,
    value: isRef ? value.slice(1) : value,
    isRef,
    placement: type === "say" ? "replic" : type === "audio" ? "background" : "screen",
    duration: num(attr(a, "time"), 0) || undefined,
  };
}

function rangeOfRound(prices: number[]): PriceRange {
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return { min, max, step: max - min || 1 };
}

function questionV4(q: Node, roundPrices: number[]): Question {
  const typeNode = q.type;
  const typeName = (attr(typeNode, "name") ?? "simple").toLowerCase();
  const tparams = new Map<string, string>();
  for (const p of arr(typeNode?.param)) tparams.set((attr(p, "name") ?? "").toLowerCase(), text(p));

  const content: ContentItem[] = [];
  const answerContent: ContentItem[] = [];
  let afterMarker = false;
  for (const a of arr<Node | string>(q.scenario?.atom)) {
    const item = atomItem(a);
    if (item.marker) { afterMarker = true; continue; }
    (afterMarker ? answerContent : content).push(item);
  }

  let type: QuestionType = "simple";
  let secretPrice: PriceRange | number | undefined;
  let selectionMode: Question["selectionMode"];
  if (typeName === "auction") type = "stake";
  else if (typeName === "sponsored") type = "noRisk";
  else if (typeName === "cat" || typeName === "bagcat") {
    type = "secret";
    const cost = num(tparams.get("cost"), 0);
    secretPrice = cost > 0 ? cost : rangeOfRound(roundPrices);
    const self = (tparams.get("self") ?? "false").toLowerCase();
    selectionMode = typeName === "cat" || self === "false" ? "exceptCurrent" : "any";
    if (typeName === "bagcat" && tparams.get("knows")?.toLowerCase() === "never") type = "secretNoQuestion";
  }

  return {
    price: num(attr(q, "price")),
    type,
    content,
    answerContent,
    right: arr(q.right?.answer).map(text).filter(Boolean),
    wrong: arr(q.wrong?.answer).map(text).filter(Boolean),
    comment: arr(q.info?.comments).map(text).join("\n") || undefined,
    secretTheme: type === "secret" || type === "secretNoQuestion" ? tparams.get("theme") || undefined : undefined,
    secretPrice,
    selectionMode,
  };
}

/* ---------- Package ---------- */

export function parseContentXml(xml: string): Pack {
  const doc = parser.parse(xml) as Node;
  const p = doc.package;
  if (!p) throw new Error("В content.xml нет элемента <package>");
  const version = num(attr(p, "version"), 4);
  const isV5 = version >= 5;

  const rounds: Round[] = arr(p.rounds?.round).map((r) => {
    const themesRaw = arr(r.themes?.theme);
    const roundPrices = themesRaw.flatMap((t) => arr(t.questions?.question).map((q) => num(attr(q, "price")))).filter((x) => x > 0);
    const themes: Theme[] = themesRaw.map((t) => ({
      name: attr(t, "name") ?? "",
      comment: arr(t.info?.comments).map(text).join("\n") || undefined,
      questions: arr(t.questions?.question).map((q) => (isV5 ? questionV5(q, roundPrices) : questionV4(q, roundPrices))),
    }));
    return { name: attr(r, "name") ?? "", type: (attr(r, "type") ?? "").toLowerCase() === "final" ? "final" : "standard", themes };
  });

  const logo = attr(p, "logo");
  return {
    name: attr(p, "name") ?? "Без названия",
    version,
    id: attr(p, "id"),
    date: attr(p, "date"),
    difficulty: attr(p, "difficulty") ? num(attr(p, "difficulty")) : undefined,
    authors: authors(p.info),
    logo: logo ? logo.replace(/^@/, "") : undefined,
    rounds,
  };
}
