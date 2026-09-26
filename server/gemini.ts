import { createHash } from "node:crypto";
import {
  GoogleGenAI, Modality, ThinkingLevel,
  type GenerateContentParameters, type LiveConnectParameters, type Session,
} from "@google/genai";
import { z } from "zod/v4";
import type { ConversationContext, DialogueReply, DirectorContext, DirectorReply } from "../shared/types";
import { limits, type ServerConfig } from "./config";
import { invalidResponse, providerError, ServiceError } from "./errors";
import {
  actionIsAllowed, conversationInstruction, directorInstruction, directorSnapshot,
} from "./prompts";
import { dialogueReplySchema, directorReplySchema, generationJsonSchema } from "./schemas";
import { generatedAudioToWav } from "./wav";

export type LiveSession = Pick<Session, "sendClientContent" | "sendRealtimeInput" | "sendToolResponse" | "close">;
export interface GeminiTransport {
  generateContent(params: GenerateContentParameters): Promise<unknown>;
  connect(params: LiveConnectParameters): Promise<LiveSession>;
}
export interface GeminiService {
  director(context: DirectorContext, signal: AbortSignal): Promise<DirectorReply>;
  dialogue(context: ConversationContext, text: string, signal: AbortSignal): Promise<DialogueReply>;
  tts(text: string, voiceName: string, signal: AbortSignal): Promise<Buffer>;
  connectLive(params: Omit<LiveConnectParameters, "model">): Promise<LiveSession>;
}

const voiceNames = new Set([
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi",
  "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird",
  "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
]);
const partSchema = z.object({
  text: z.string().optional(), thought: z.boolean().optional(), schemaOutput: z.unknown().optional(),
  inlineData: z.object({ data: z.string(), mimeType: z.string() }).optional(),
});
const responseEnvelope = z.object({
  schemaOutput: z.unknown().optional(),
  candidates: z.array(z.object({
    finishReason: z.string().optional(),
    content: z.object({ parts: z.array(partSchema) }).optional(),
  })).optional(),
});

function envelope(response: unknown) {
  const parsed = responseEnvelope.safeParse(response);
  if (!parsed.success) throw invalidResponse();
  const candidate = parsed.data.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== "STOP") throw invalidResponse();
  return { response: parsed.data, parts: candidate?.content?.parts ?? [] };
}

export function parseStructuredResponse<T>(response: unknown, schema: z.ZodType<T>): T {
  const result = envelope(response);
  const structured = result.response.schemaOutput
    ?? result.parts.find(part => !part.thought && part.schemaOutput !== undefined)?.schemaOutput;
  let value: unknown = structured;
  if (value === undefined) value = result.parts.filter(part => !part.thought && part.text).map(part => part.text).join("");
  if (typeof value === "string") {
    if (!value || value.length > 100_000) throw invalidResponse();
    try { value = JSON.parse(value); } catch { throw invalidResponse(); }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

export function validateDirectorReply(reply: DirectorReply, context: DirectorContext): DirectorReply {
  const ids = new Set(context.npcs.map(npc => npc.definition.id));
  const seen = new Set<string>();
  for (const intent of reply.intents) {
    if (!ids.has(intent.npcId) || seen.has(intent.npcId)) throw invalidResponse();
    seen.add(intent.npcId);
    if (intent.target && (intent.target.x >= context.floor.width || intent.target.y >= context.floor.height)) throw invalidResponse();
    if (intent.targetNpcId && (!ids.has(intent.targetNpcId) || intent.targetNpcId === intent.npcId)) throw invalidResponse();
    if (intent.action === "chat_with" && !intent.targetNpcId) throw invalidResponse();
    if (["walk_to", "emerge_from", "investigate", "block_path"].includes(intent.action) && !intent.target) throw invalidResponse();
  }
  if (reply.chatter.some(item => !ids.has(item.from) || !ids.has(item.to) || item.from === item.to)) throw invalidResponse();
  return reply;
}

export function createGeminiService(config: ServerConfig, injected?: GeminiTransport): GeminiService {
  let transport = injected;
  const audioCache = new Map<string, { audio: Buffer; expires: number }>();
  let cacheBytes = 0;

  function client(): GeminiTransport {
    if (!config.apiKey) throw new ServiceError(503, "NOT_CONFIGURED", "GEMINI_API_KEY is not configured on the server. Text and voice generation are unavailable; practice mode remains available.");
    if (!transport) {
      const ai = new GoogleGenAI({
        apiKey: config.apiKey, vertexai: false,
        // The default SDK transport makes one fetch; its opt-in retry wrapper loses HTTP error status.
        httpOptions: { apiVersion: "v1beta", timeout: limits.ttsTimeoutMs },
      });
      transport = {
        generateContent: params => ai.models.generateContent(params),
        connect: params => ai.live.connect(params),
      };
    }
    return transport;
  }

  async function structured<T>(instruction: string, input: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    try {
      const response = await client().generateContent({
        model: config.models.text,
        contents: [{ role: "user", parts: [{ text: input }] }],
        config: {
          abortSignal: signal, systemInstruction: instruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: "application/json", responseJsonSchema: generationJsonSchema(schema),
          maxOutputTokens: 4096, candidateCount: 1,
          httpOptions: { timeout: limits.requestTimeoutMs },
        },
      });
      signal.throwIfAborted();
      return parseStructuredResponse(response, schema);
    } catch (error) {
      throw providerError(error);
    }
  }

  return {
    async director(context, signal) {
      const reply = await structured(directorInstruction, JSON.stringify(directorSnapshot(context)), directorReplySchema, signal);
      return validateDirectorReply(reply, context);
    },
    async dialogue(context, text, signal) {
      const reply = await structured(conversationInstruction(context, false), JSON.stringify({ visitorSaid: text }), dialogueReplySchema, signal);
      if (reply.actions.some(action => !actionIsAllowed(action, context))) throw invalidResponse();
      const endIndex = reply.actions.findIndex(action => action.type === "end_conversation");
      if (endIndex !== -1 && endIndex !== reply.actions.length - 1) throw invalidResponse();
      return reply;
    },
    async tts(text, voiceName, signal) {
      if (!voiceNames.has(voiceName)) throw new ServiceError(400, "INVALID_VOICE", "Choose a supported Gemini prebuilt voice name.");
      signal.throwIfAborted();
      const key = createHash("sha256").update(`${config.models.tts}\0${voiceName}\0${text}`).digest("hex");
      const cached = audioCache.get(key);
      if (cached && cached.expires > Date.now()) {
        audioCache.delete(key);
        audioCache.set(key, cached);
        return cached.audio;
      }
      if (cached) {
        cacheBytes -= cached.audio.length;
        audioCache.delete(key);
      }
      try {
        const response = await client().generateContent({
          model: config.models.tts,
          contents: [{ role: "user", parts: [{ text }] }],
          config: {
            abortSignal: signal, responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
            maxOutputTokens: 4096, httpOptions: { timeout: limits.ttsTimeoutMs },
          },
        });
        signal.throwIfAborted();
        const audio = generatedAudioToWav(envelope(response).parts.flatMap(part => part.inlineData ? [part.inlineData] : []));
        if ((audio.length - 44) / 48_000 > 60) throw invalidResponse();
        audioCache.set(key, { audio, expires: Date.now() + 10 * 60_000 });
        cacheBytes += audio.length;
        while (audioCache.size > 24 || cacheBytes > 16 * 1024 * 1024) {
          const oldest = audioCache.entries().next().value;
          if (!oldest) break;
          cacheBytes -= oldest[1].audio.length;
          audioCache.delete(oldest[0]);
        }
        return audio;
      } catch (error) {
        throw providerError(error);
      }
    },
    async connectLive(params) {
      try { return await client().connect({ ...params, model: config.models.live }); }
      catch (error) { throw providerError(error); }
    },
  };
}
