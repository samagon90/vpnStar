import { Bot } from 'grammy';
import { cfg } from './config.js';

let sharedBot = null;

/** Общий экземпляр бота для отправки уведомлений (cron). index.js передаёт его сюда. */
export function setBot(bot) {
  sharedBot = bot;
}
export function botApi() {
  return sharedBot;
}
