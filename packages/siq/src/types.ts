/** Normalized pack model. Both SIQ format 4 (atoms) and format 5 (params/items) map onto it. */

export type MediaKind = "image" | "audio" | "video" | "html";
export type ItemType = "text" | "say" | MediaKind;
export type Placement = "screen" | "replic" | "background";

export interface ContentItem {
  type: ItemType;
  /** Text for text/say items; file name (isRef) or URL for media. */
  value: string;
  /** True when the value points to a file inside the pack archive. */
  isRef: boolean;
  placement: Placement;
  /** Seconds, if the pack specified a duration. */
  duration?: number;
  waitForFinish?: boolean;
}

export type QuestionType =
  | "simple"
  | "stake" // auction
  | "secret" // "cat in the bag": chooser hands the question to someone else
  | "secretPublicPrice"
  | "secretNoQuestion" // cat that only gives points
  | "noRisk" // no penalty, double reward ("forYourself" in SIGame is the same script)
  | "forAll" // everyone answers in writing
  | "stakeAll"; // everyone stakes secretly, then everyone answers

export interface PriceRange {
  min: number;
  max: number;
  step: number;
}

export interface Question {
  price: number;
  type: QuestionType;
  content: ContentItem[];
  answerContent: ContentItem[];
  right: string[];
  wrong: string[];
  comment?: string;
  /** For secret questions: theme shown to the recipient and how the price is set. */
  secretTheme?: string;
  secretPrice?: PriceRange | number;
  selectionMode?: "any" | "exceptCurrent";
  answerOptions?: { label: string; content: ContentItem[] }[];
  /** SIGame answerType: "text" (default), "number", "select", "point"… */
  answerType?: string;
  /** For number answers: how far from the right number still counts. */
  answerDeviation?: number;
}

export interface Theme {
  name: string;
  comment?: string;
  questions: Question[];
}

export interface Round {
  name: string;
  type: "standard" | "final";
  themes: Theme[];
}

export interface Pack {
  name: string;
  version: number;
  id?: string;
  date?: string;
  difficulty?: number;
  authors: string[];
  logo?: string;
  rounds: Round[];
}

export interface PackStats {
  rounds: number;
  themes: number;
  questions: number;
  mediaFiles: number;
}
