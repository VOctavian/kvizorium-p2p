/** Messages and views shared by the game server and every client (web, desktop). */

import { KIND_LABELS, type Text } from "./text.ts";

export * from "./text.ts";

export type Role = "host" | "player" | "viewer";
export type HostMode = "human" | "auto";
export type QuestionKind = "simple" | "stake" | "secret" | "secretNoQuestion" | "noRisk" | "forAll" | "stakeAll";

export type GameType = "classic" | "simple";

export interface Settings {
  /** Number of seats at the table, 1..12. */
  maxPlayers: number;
  hostMode: HostMode;
  /** Oral game: players answer aloud and the human host judges. Written otherwise. */
  oral: boolean;
  /** "simple": every question plays as an ordinary one, no final round. */
  gameType: GameType;
  /** Seconds players have to press the button after it opens. */
  thinkTime: number;
  /** Seconds to answer after pressing. */
  answerTime: number;
  /** Seconds the chooser has to pick a question; 0 = no limit. */
  chooseTime: number;
  /** Seconds for auction bids, giving a cat in the bag, final stakes. */
  stakeTime: number;
  /** Seconds to write the final answer. */
  finalTime: number;
  /** Minutes per round; 0 = no limit. */
  roundTime: number;
  /** Pressing before the button opens blocks the player for a moment. */
  falseStart: boolean;
  /** A wrong answer costs the question's price. */
  wrongPenalty: boolean;
  /** Karaoke: letters of the question change colour as the host "reads" them. */
  karaoke: boolean;
  /** Reading speed for karaoke and for how long the question is read, characters per second. */
  readSpeed: number;
  /** Seconds a picture takes to appear line by line from the top; 0 = at once. */
  imageReveal: number;
  allowViewers: boolean;
  /**
   * Anonymous pack: only the host learns the pack's name. Players and viewers get a made-up
   * name, no authors or logo, and media links that don't carry file names.
   */
  anonPack: boolean;
  /** Anyone may take the host's seat while it is free. */
  openHost: boolean;
  /** Packs with several final rounds: play them all, or only the first. */
  finals: "all" | "one";
}

export const DEFAULT_SETTINGS: Settings = {
  maxPlayers: 6,
  hostMode: "human",
  oral: false,
  gameType: "classic",
  thinkTime: 30,
  answerTime: 30,
  chooseTime: 45,
  stakeTime: 30,
  finalTime: 60,
  roundTime: 0,
  falseStart: true,
  wrongPenalty: true,
  karaoke: true,
  readSpeed: 18,
  imageReveal: 0,
  allowViewers: true,
  anonPack: false,
  openHost: true,
  finals: "all",
};

/** Allowed ranges, shared by the server (clamping) and the client (inputs). */
export const SETTING_LIMITS = {
  maxPlayers: [1, 12],
  thinkTime: [3, 60],
  answerTime: [5, 120],
  chooseTime: [0, 120],
  stakeTime: [5, 60],
  finalTime: [15, 180],
  roundTime: [0, 60],
  readSpeed: [5, 60],
  imageReveal: [0, 15],
} as const satisfies Partial<Record<keyof Settings, readonly [number, number]>>;

export interface MediaView {
  type: "text" | "say" | "image" | "audio" | "video" | "html";
  text?: string;
  /** Absolute path on the game server, e.g. /media/abc/Images/x.png (built-in packs). */
  url?: string;
  /**
   * A pack shared between players: the file's number in the room's file list (see `swarm`) and
   * its key. Players hold the file encrypted; the key comes only when the item is on screen.
   */
  file?: number;
  key?: string;
  /** The shared file's type (from its extension), so the browser knows how to show it. */
  mime?: string;
  placement?: "screen" | "replic" | "background";
  /** Seconds the pack gives an audio/video piece (used to time what appears next). */
  duration?: number;
}

export type Gender = "m" | "f";

export interface PersonView {
  id: string;
  name: string;
  avatar?: string;
  online: boolean;
  gender?: Gender;
}

export interface PlayerView extends PersonView {
  score: number;
  ready: boolean;
}

export type Phase =
  | "lobby"
  | "roundIntro"
  | "choosing"
  | "secret"
  | "stake"
  | "stakeAll"
  | "question"
  | "finalThemes"
  | "finalStakes"
  | "finalAnswer"
  | "finalJudge"
  | "finalReveal"
  | "gameOver";

export interface TimerView {
  /** `load`: waiting until everyone's browser has loaded the question's media. */
  kind: "load" | "read" | "think" | "answer" | "choose" | "stake" | "secret" | "final" | "intro" | "reveal";
  endsAt: number;
  duration: number;
  /** Set while the game is paused: seconds left. */
  pausedLeft?: number;
}

export interface BoardView {
  index: number;
  count: number;
  name: string;
  final: boolean;
  /** null marks a question that has already been played. */
  themes: { name: string; prices: (number | null)[]; /** Host only: every price, played or not (for editing). */ all?: number[] }[];
  /** Server time when the round's time limit runs out. */
  roundEndsAt?: number;
}

export interface QuestionView {
  themeIndex: number;
  index: number;
  theme: string;
  price: number;
  kind: QuestionKind;
  /** "judging": a question for everyone waits for the host to check the written answers. */
  stage: "reading" | "open" | "answering" | "judging" | "reveal";
  content: MediaView[];
  /** The host always sees it; everyone sees it at the reveal. */
  answer?: { text: string[]; content: MediaView[] };
  answeringId?: string;
  /** What the answering player is typing (visible to the host and the player). */
  typed?: string;
  submitted?: boolean;
  wrongIds: string[];
  /** Players who passed on this question (they won't press the button). */
  passedIds: string[];
  /** Only this player may answer (auction, cat in the bag, no-risk question). */
  soloId?: string;
  lastResult?: { playerId: string; correct: boolean; delta: number; mult?: number };
  /** While media load: how many of the people we wait for are ready. */
  loading?: { ready: number; total: number };
  /** Players the host scored at 0 for this question: shown like a pass. */
  zeroIds?: string[];
  /** Answer choices for "select" questions; the answering player picks one by label. */
  options?: { label: string; text: string; wrong?: boolean }[];
  /** "For everyone" questions: all players write an answer at once. */
  forAll?: {
    /** Players who answer (for "stakes for everyone" only those who staked). */
    who: string[];
    done: string[];
    myAnswer?: string;
    /** Host sees them while judging; everyone sees them at the reveal. */
    answers?: { id: string; answer: string; correct?: boolean; delta?: number; stake?: number; mult?: number }[];
  };
}

export interface StakeView {
  nominal: number;
  leaderId?: string;
  value: number;
  turnId?: string;
  passed: string[];
  allIn: boolean;
  minBid: number;
}

export interface SecretView {
  giverId: string;
  recipientId?: string;
  candidates: string[];
  theme: string;
  price: number;
  priceChoice?: { min: number; max: number; step: number };
}

export interface FinalView {
  themes: { name: string; removed: boolean }[];
  turnId?: string;
  participants: string[];
  stakesDone: string[];
  answersDone: string[];
  myStake?: number;
  myAnswer?: string;
  /** Host sees answers while judging; everyone sees them at the reveal. */
  answers?: { id: string; answer: string; stake?: number; correct?: boolean }[];
}

export interface PackInfo {
  name: string;
  authors: string[];
  rounds: { name: string; final: boolean; themes: number; questions: number }[];
  questions: number;
  version: number;
  logo?: string;
  sizeMb: number;
  /** The name is hidden from players: they get a made-up `name` (the host gets the real one). */
  hidden?: boolean;
  /** Language of the pack's text, guessed from its alphabet. */
  lang?: "ru" | "other";
  /** After the game: where to download the pack (only when its name may be seen). */
  downloadUrl?: string;
  /** An anonymous pack whose name the leader has shown to everyone after the game. */
  revealed?: boolean;
  /** The media travel between players' browsers; the server has only the questions. */
  shared?: boolean;
}

/** Biggest pack a room takes, MB. */
export const MAX_PACK_MB = 150;

/** A shared pack: who at the table has how much of it. */
export interface ShareView {
  /** Files in the pack, and how many of them the first round needs. */
  total: number;
  firstRound: number;
  /** Players and the host: files they have; whether they have the whole first round. */
  people: { id: string; have: number; firstRound: boolean }[];
  /** Everyone at the table has the first round: the game can start. */
  ready: boolean;
}

/** One media file of a shared pack, as the leader's browser describes it to the server. */
export interface SharedFile {
  /** Path in the archive, e.g. "Images/x.png" (the server alone sees it). */
  path: string;
  /** Bytes of the encrypted file (12-byte IV + AES-GCM ciphertext). */
  size: number;
  /** SHA-256 of the encrypted file, hex: every browser checks what it receives. */
  hash: string;
  /** AES-GCM key, base64 (the server hands it out when the item is shown). */
  key: string;
  /** Seconds, for sound and video: measured by the leader's browser, so the reading lasts as long as the clip. */
  dur?: number;
  /** Set when the leader's browser converted the file (e.g. WMV to MP4): its real type, whatever the name says. */
  mime?: string;
}

export interface RoomView {
  id: string;
  name: string;
  hasPassword: boolean;
  settings: Settings;
  ownerId: string;
  /**
   * The room's leader: seats people, moves them to and from the host's seat, removes and bans,
   * changes settings and the pack. The creator while online; otherwise the host, then a player.
   */
  leaderId: string;
  me: { id: string; role: Role };
  host?: PersonView;
  players: PlayerView[];
  viewers: PersonView[];
  pack?: PackInfo;
  /** Upload status while the server takes in a pack. */
  packLoading?: Text;
  /** A shared pack: how far it has spread. */
  share?: ShareView;
  phase: Phase;
  paused: boolean;
  board?: BoardView;
  chooserId?: string;
  question?: QuestionView;
  stake?: StakeView;
  /** "Stake for everyone": players with a positive score bet secretly before the question. */
  stakeAll?: { participants: string[]; done: string[]; myStake?: number; price: number; theme: string };
  secret?: SecretView;
  final?: FinalView;
  timer?: TimerView;
  /** What the host says now (a message key the client renders in its language). */
  hostLine: Text;
  /** Link to a voice chat (Discord, Zoom, Telegram…) set by the host; opens in a new tab. */
  voiceUrl?: string;
  serverNow: number;
}

export interface RoomSummary {
  id: string;
  name: string;
  /** Absent for an anonymous pack (see `packHidden`). */
  packName?: string;
  packHidden?: boolean;
  /** The room plays with an anonymous pack (setting). */
  anonPack: boolean;
  /** Language of the pack, if one is chosen. */
  lang?: "ru" | "other";
  falseStart: boolean;
  /** Nobody sits in the host's seat. */
  hostFree: boolean;
  hostName: string;
  players: number;
  maxPlayers: number;
  status: "wait" | "play";
  round?: Text;
  hasPassword: boolean;
  avatars: { id: string; avatar?: string }[];
  hostMode: HostMode;
  oral: boolean;
  gameType: GameType;
  allowViewers: boolean;
  createdAt: number;
  startedAt?: number;
}

export interface ChatItem {
  id: number;
  at: number;
  kind: "msg" | "ev";
  fromId?: string;
  name?: string;
  avatar?: string;
  role?: Role;
  /** Chat: the message. Feed: the event rendered in Russian (for bots and logs); clients render `line`. */
  text: string;
  /** Feed events: the message key and params. */
  line?: Text;
  tone?: "good" | "bad" | "pick" | "bid" | "buzz" | "info";
  /** A judged answer the host can still correct from the feed. */
  fix?: { playerId: string; price: number; delta: number; correct: boolean; fixed?: boolean; mult?: number };
}

/**
 * How the host scores an answer: a multiple of the price. ×1 is simply "right" and ×−1 simply
 * "wrong" (the usual rules apply: no-risk doubles, the wrong-answer penalty setting); the rest
 * multiply the price as is.
 */
export const MULTIPLIERS = [-2, -1, -0.5, 0, 0.5, 1, 2] as const;
export type Multiplier = (typeof MULTIPLIERS)[number];

/** `advance`: jump to the next step (skip the reading, end a question nobody answers, pick a random card…). */
export type HostAction = "skip" | "open" | "next" | "pause" | "resume" | "nextRound" | "end" | "advance";

export type ClientMsg =
  | { t: "hello"; token: string; name: string; avatar?: string; gender?: Gender }
  | { t: "profile"; name?: string; avatar?: string | null; gender?: Gender | null }
  | { t: "listRooms" }
  | { t: "createRoom"; name: string; password?: string; settings: Partial<Settings>; asHost: boolean }
  | { t: "joinRoom"; roomId: string; password?: string; asViewer?: boolean }
  | { t: "leaveRoom" }
  | { t: "ready"; value: boolean }
  | { t: "settings"; settings: Partial<Settings> }
  | { t: "useDemoPack"; id: string }
  /** `force`: start before everyone has the shared pack's first round. */
  | { t: "start"; force?: boolean }
  | { t: "choose"; theme: number; index: number }
  | { t: "buzz" }
  | { t: "passQuestion" }
  /** The question's media are loaded in this browser (`key` = "theme:index"). */
  | { t: "mediaReady"; key: string }
  /** This browser has downloaded every file of a round sent with `preload`. */
  | { t: "preloaded"; round: number }
  /** The leader shares a pack: its questions and the list of its (encrypted) media files. */
  | { t: "sharePack"; xml: string; files: SharedFile[] }
  /** Files of the shared pack this browser has (`reset`: the whole list, replacing the last one). */
  | { t: "have"; files: number[]; reset?: boolean }
  /** WebRTC signalling to another member of the room. */
  | { t: "rtc"; to: string; data: unknown }
  | { t: "type"; text: string }
  | { t: "submit"; text: string }
  | { t: "judge"; correct: boolean; playerId?: string; mult?: Multiplier }
  | { t: "host"; action: HostAction }
  | { t: "giveSecret"; to: string }
  | { t: "secretPrice"; value: number }
  | { t: "bid"; kind: "bid" | "pass" | "allin"; value?: number }
  | { t: "removeTheme"; index: number }
  | { t: "finalStake"; value: number }
  | { t: "stakeAll"; value: number }
  | { t: "chat"; text: string }
  /** Leader: remove from the room together with the table. */
  | { t: "kick"; id: string }
  /** Leader: the player leaves the table (it stays free) and watches. */
  | { t: "freeSeat"; id: string }
  /** Leader: remove from the room and don't let back in. */
  | { t: "ban"; id: string }
  /** Leader: put someone in the host's seat, or (null) send the host to the viewers. */
  | { t: "setHost"; id: string | null }
  /** Take the free host's seat yourself / leave it. */
  | { t: "takeHost" }
  /** After the game: show an anonymous pack's name (and download link) to everyone. */
  | { t: "revealPack" }
  | { t: "leaveHost" }
  | { t: "setScore"; id: string; score: number }
  | { t: "becomePlayer" }
  | { t: "seat"; action: "add" | "remove"; playerId?: string }
  | { t: "swapHost"; playerId: string }
  | { t: "edit"; theme: number; index?: number; remove: boolean }
  | { t: "setRound"; index: number }
  | { t: "setChooser"; playerId: string }
  | { t: "voice"; url: string | null }
  | { t: "fixScore"; chatId: number; mult: Multiplier };

export type ServerMsg =
  | { t: "welcome"; you: { id: string; name: string; avatar?: string }; demoPacks: { id: string; name: string }[] }
  | { t: "rooms"; rooms: RoomSummary[] }
  | { t: "stats"; stats: LobbyStats }
  | { t: "room"; room: RoomView }
  | { t: "left"; reason?: string; text?: Text }
  | { t: "chat"; items: ChatItem[]; reset?: boolean }
  /**
   * Media to download ahead of time: the current round's questions, then (once every player has
   * them) the next round's. Answers' media are never sent early.
   */
  | { t: "preload"; round: number; urls: string[]; next?: boolean }
  /**
   * The room's shared pack: its files (sizes and hashes, no names or keys), the order to download
   * them in, and who has what. `id` changes with the pack; an empty list means no shared pack.
   */
  | { t: "swarm"; id: string; files: { size: number; hash: string }[]; order: number[]; holders: Record<string, number[]> }
  /** Someone has more files (`reset`: their whole list; empty when they left). */
  | { t: "have"; from: string; files: number[]; reset?: boolean }
  | { t: "rtc"; from: string; data: unknown }
  /** `message` is Russian (or raw text from the pack parser); `text` is the key a client renders. */
  | { t: "error"; message: string; text?: Text };

/** Russian labels; clients take theirs from KIND_LABELS. */
export const KIND_LABEL = KIND_LABELS.ru as Record<QuestionKind, string>;

/** Lenient answer comparison for the automatic host. */
export function normalizeAnswer(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'`.,!?:;()\[\]{}\-–—_/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function answerMatches(given: string, right: string[]): boolean {
  const g = normalizeAnswer(given);
  if (!g) return false;
  return right.some((r) => {
    const n = normalizeAnswer(r);
    if (!n) return false;
    if (g === n) return true;
    if (n.length >= 4 && (g.includes(n) || (g.length >= 4 && n.includes(g) && g.length >= n.length * 0.6))) return true;
    return levenshtein(g, n) <= Math.floor(n.length / 6);
  });
}

/** Games page, right column: the most played packs and the latest finished games. */
export interface TopPack { hash: string; name: string; games: number; questions: number; lastPlayed: number }
export interface RecentGame {
  id: string;
  roomName: string;
  /** Absent while an anonymous pack stays hidden. */
  packName?: string;
  packHidden?: boolean;
  winner?: string;
  winnerScore?: number;
  players: number;
  endedAt: number;
  minutes?: number;
}
export interface LobbyStats { top: TopPack[]; recent: RecentGame[] }
