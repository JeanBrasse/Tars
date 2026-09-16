import * as http from 'http';
import { BrowserWindow } from 'electron';
import TelegramBot from 'node-telegram-bot-api';
import { App as SlackApp } from '@slack/bolt';
import { EventEmitter } from 'events';
import { AgentStatus, AppSettings } from '../../types';

export interface RouteContext {
  mainWindow: BrowserWindow | null;
  appSettings: AppSettings;          // Initial snapshot, prefer getAppSettings() for live values
  getAppSettings: () => AppSettings; // Always returns the current appSettings
  getTelegramBot: () => TelegramBot | null;
  getSlackApp: () => SlackApp | null;
  slackResponseChannel: string | null;
  slackResponseThreadTs: string | null;
  handleStatusChangeNotificationCallback: (agent: AgentStatus, newStatus: string) => void;
  sendNotificationCallback: (title: string, body: string, agentId?: string, appSettings?: { notificationsEnabled: boolean; notificationSounds?: Record<string, string> }) => void;
  initAgentPtyCallback: (agent: AgentStatus) => Promise<string>;
  agentStatusEmitter: EventEmitter;
}

export interface RouteRequest {
  method: string;
  pathname: string;
  url: URL;
  body: Record<string, unknown>;
  raw: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  /**
   * The agent this call comes from: the one its bearer token was minted for,
   * resolved once by the server before any route sees the request. Undefined
   * on the shared token, whoever presents it: the super chat, the shell hooks,
   * Hermes, or a process that read the file. Never set from a header: the
   * header is the claim this field exists to check.
   */
  callerAgentId?: string;
}

export type SendJson = (data: unknown, status?: number) => void;

export type RouteHandler = (req: RouteRequest, sendJson: SendJson, ctx: RouteContext) => Promise<void> | void;

export interface RouteDefinition {
  method: string;
  pattern: string | RegExp;
  handler: RouteHandler;
}

export interface RouteApp {
  routes: RouteDefinition[];
  add(method: string, pattern: string | RegExp, handler: RouteHandler): void;
  get(pattern: string | RegExp, handler: RouteHandler): void;
  post(pattern: string | RegExp, handler: RouteHandler): void;
  put(pattern: string | RegExp, handler: RouteHandler): void;
  delete(pattern: string | RegExp, handler: RouteHandler): void;
}
