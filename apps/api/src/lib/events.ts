import { EventEmitter } from "node:events";

export interface PostEventPayload {
  id: string;
  slug: string;
}

export interface PostSubmittedEventPayload {
  id: string;
  slug: string;
  title: string;
  authorName: string;
}

export interface CommentCreatedEventPayload {
  post: { id: string; slug: string; title: string };
  comment: {
    id: string;
    parentId: string | null;
    body: string;
    bodyHtml: string;
    status: "visible" | "pending";
    createdAt: string;
  };
  author: {
    name: string;
    userId: string | null;
    isAdmin: boolean;
  };
}

interface BlogEventMap {
  "post.published": [PostEventPayload];
  "post.updated": [PostEventPayload];
  "post.unpublished": [PostEventPayload];
  "post.submitted": [PostSubmittedEventPayload];
  "comment.created": [CommentCreatedEventPayload];
}

/**
 * Tipizatsiya qilingan event emitter — Telegram integratsiyasi (Phase 6)
 * shu hodisalarga obuna bo'ladi (masalan `post.published` — kanalga avtomatik
 * post yuborish uchun).
 */
class TypedEventEmitter extends EventEmitter {
  override emit<K extends keyof BlogEventMap>(event: K, ...args: BlogEventMap[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof BlogEventMap>(
    event: K,
    listener: (...args: BlogEventMap[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}

export const events = new TypedEventEmitter();
