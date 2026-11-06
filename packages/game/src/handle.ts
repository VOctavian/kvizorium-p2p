import { formatText, text, type ClientMsg, type ServerMsg, type Text } from "@kvz/protocol";
import type { Room, User } from "./room.ts";

/** Error for the socket: Russian `message` for bots and old clients, `text` for the web client. Raw strings (pack parser) go as is. */
export function errorMsg(e: Text | string): ServerMsg {
  return typeof e === "string" ? { t: "error", message: e } : { t: "error", message: formatText("ru", e), text: e };
}

/** What only the place that keeps the room can do with packs (server disk, or the browser). */
export interface PackHooks {
  useDemoPack(room: Room, user: User, id: string, err: (e: Text | string) => void): void;
  sharePack(room: Room, user: User, msg: Extract<ClientMsg, { t: "sharePack" }>, err: (e: Text | string) => void): void;
}

/**
 * A message about the game in a room. The same code runs on the server and in a browser that keeps
 * a room for the others. Returns false for messages that aren't about the room.
 */
/** Messages that are just the browsers' own business: they don't count as anyone doing anything. */
const QUIET = new Set<ClientMsg["t"]>(["have", "rtc", "mediaReady", "preloaded", "hello", "profile", "listRooms", "joinRoom", "leaveRoom"]);

export function handleRoomMsg(room: Room, user: User, msg: ClientMsg, hooks: PackHooks): boolean {
  const err = (e: Text | string | null | undefined | void) => { if (e) user.send(errorMsg(e)); };
  if (!QUIET.has(msg.t)) room.touch();
  switch (msg.t) {
    case "chat": room.say(user, msg.text); return true;
    case "ready": room.setReady(user.id, msg.value); return true;
    case "settings": err(room.setSettings(user.id, msg.settings)); return true;
    case "useDemoPack":
      if (!room.isLeader(user.id)) err(text("err.leaderOnly"));
      else if (room.phase !== "lobby") err(text("err.packLobby"));
      else hooks.useDemoPack(room, user, msg.id, err);
      return true;
    case "sharePack":
      if (!room.isLeader(user.id)) err(text("err.leaderOnly"));
      else if (room.phase !== "lobby") err(text("err.packLobby"));
      else hooks.sharePack(room, user, msg, err);
      return true;
    case "start": err(room.start(user.id, !!msg.force)); return true;
    case "have": room.have(user.id, msg.files, msg.reset); return true;
    case "rtc": room.relay(user.id, msg.to, msg.data); return true;
    case "choose": err(room.choose(user.id, msg.theme, msg.index)); return true;
    case "buzz": room.buzz(user.id); return true;
    case "passQuestion": room.passQuestion(user.id); return true;
    case "mediaReady": room.mediaReady(user.id, msg.key); return true;
    case "preloaded": room.preloaded(user.id, msg.round); return true;
    case "type": room.type(user.id, msg.text); return true;
    case "submit": room.submit(user.id, msg.text); return true;
    case "judge": err(room.judge(user.id, msg.correct, msg.playerId, msg.mult)); return true;
    case "host":
      if (msg.action === "end" && room.phase === "gameOver") {
        if (!room.isLeader(user.id)) err(text("err.leaderOnly"));
        else room.backToLobby();
      } else err(room.hostAction(user.id, msg.action));
      return true;
    case "giveSecret": err(room.giveSecret(user.id, msg.to)); return true;
    case "secretPrice": err(room.setSecretPrice(user.id, msg.value)); return true;
    case "bid": err(room.bid(user.id, msg.kind, msg.value)); return true;
    case "removeTheme": err(room.removeTheme(user.id, msg.index)); return true;
    case "finalStake": err(room.finalStake(user.id, msg.value)); return true;
    case "stakeAll": err(room.stakeAllBet(user.id, msg.value)); return true;
    case "kick": err(room.kick(user.id, msg.id)); return true;
    case "ban": err(room.kick(user.id, msg.id, true)); return true;
    case "freeSeat": err(room.freeSeat(user.id, msg.id)); return true;
    case "setHost": err(room.setHost(user.id, msg.id)); return true;
    case "takeHost": err(room.takeHost(user.id)); return true;
    case "revealPack": err(room.revealPack(user.id)); return true;
    case "leaveHost": err(room.leaveHost(user.id)); return true;
    case "setScore": err(room.setScore(user.id, msg.id, msg.score)); return true;
    case "becomePlayer": err(room.becomePlayer(user.id)); return true;
    case "seat": err(room.seat(user.id, msg.action, msg.playerId)); return true;
    case "swapHost": err(room.setHost(user.id, msg.playerId)); return true;
    case "edit": err(room.editBoard(user.id, msg.theme, msg.index, msg.remove)); return true;
    case "setRound": err(room.setRound(user.id, msg.index)); return true;
    case "setChooser": err(room.setChooser(user.id, msg.playerId)); return true;
    case "voice": err(room.setVoice(user.id, msg.url)); return true;
    case "fixScore": err(room.fixScore(user.id, msg.chatId, msg.mult)); return true;
    case "setLeader": err(room.setLeader(user.id, msg.id)); return true;
    case "react": room.react(user.id, msg.e); return true;
    case "extendRoom": err(room.extend(user.id)); return true;
    case "closeRoom": err(room.closeByLeader(user.id)); return true;
  }
  return false;
}
