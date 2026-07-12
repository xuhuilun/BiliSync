import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Writable } from "node:stream";
import test from "node:test";
import { tryHandleWebRoutes } from "../src/web-routes.js";

function createRequest(body: unknown): IncomingMessage {
  return {
    method: "POST",
    url: "/api/web/voice/token",
    headers: { "content-type": "application/json" },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify(body));
    },
  } as IncomingMessage;
}

function createResponse() {
  class TestResponse extends Writable {
    statusCode = 0;
    headers: Record<string, string> = {};
    body = "";

    _write(
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      callback();
    }

    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode;
      this.headers = headers;
      return this;
    }

    end(body?: string | Buffer) {
      if (body !== undefined) {
        this.body += Buffer.isBuffer(body) ? body.toString("utf8") : body;
      }
      super.end();
      return this;
    }
  }

  return new TestResponse() as unknown as ServerResponse & {
    statusCode: number;
    body: string;
  };
}

test("issues a short-lived TRTC credential to an active room member", async () => {
  const response = createResponse();
  const signedUsers: string[] = [];

  const handled = await tryHandleWebRoutes({
    request: createRequest({ roomCode: "ABC123", memberToken: "secret-token" }),
    response,
    pathname: "/api/web/voice/token",
    roomService: {
      getRoom: async () => null,
      isMemberTokenInRoom: async (roomCode, token) =>
        roomCode === "ABC123" && token === "secret-token",
      resolveMemberIdByToken: async () => "member-123",
    },
    dependencies: {
      trtc: {
        sdkAppId: 1400000001,
        expireSeconds: 900,
        generateUserSig(userId) {
          signedUsers.push(userId);
          return "signed-user-sig";
        },
        generatePrivateMapKey(userId, roomId) {
          assert.equal(userId, signedUsers[0]);
          assert.equal(roomId, "ABC123");
          return "room-bound-key";
        },
      },
    },
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as {
    data: {
      sdkAppId: number;
      userId: string;
      userSig: string;
      privateMapKey: string;
      roomId: string;
      expiresInSeconds: number;
    };
  };
  assert.deepEqual(payload.data, {
    sdkAppId: 1400000001,
    userId: signedUsers[0],
    userSig: "signed-user-sig",
    privateMapKey: "room-bound-key",
    roomId: "ABC123",
    expiresInSeconds: 900,
  });
  assert.match(payload.data.userId, /^web_[a-f0-9]{28}$/);
  assert.equal(payload.data.userId.length, 32);
  assert.equal(payload.data.userId.includes("secret-token"), false);
});

test("does not reveal whether a room exists for an invalid member token", async () => {
  const response = createResponse();

  await tryHandleWebRoutes({
    request: createRequest({ roomCode: "ABC123", memberToken: "invalid" }),
    response,
    pathname: "/api/web/voice/token",
    roomService: {
      getRoom: async () => null,
      isMemberTokenInRoom: async () => false,
      resolveMemberIdByToken: async () => null,
    },
    dependencies: {
      trtc: {
        sdkAppId: 1400000001,
        expireSeconds: 900,
        generateUserSig: () => "must-not-be-called",
        generatePrivateMapKey: () => "must-not-be-called",
      },
    },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    error: { code: "not_found", message: "Not found." },
  });
});

test("returns service unavailable when TRTC is not configured", async () => {
  const response = createResponse();

  await tryHandleWebRoutes({
    request: createRequest({ roomCode: "ABC123", memberToken: "token" }),
    response,
    pathname: "/api/web/voice/token",
    roomService: {
      getRoom: async () => null,
      isMemberTokenInRoom: async () => true,
      resolveMemberIdByToken: async () => "member-123",
    },
  });

  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error.code, "voice_unavailable");
});
