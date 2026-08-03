// Signed transient state for the onboarding flows.
//
// The browser carries this value between steps, but it is not an authority:
// every consumer verifies the HMAC, freshness, tenant binding, and payload
// schema before it can call an answerer or perform a project-side effect.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SecretStore } from "../contracts/secretStore.js";
import { InterviewCapture } from "./interview/types.js";
import { ReconReport } from "./brownfield/types.js";

const STATE_SECRET_REF = "platform/onboarding/state-signing";
const STATE_VERSION = 1 as const;
const STATE_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;

const StateBase = z.object({
  version: z.literal(STATE_VERSION),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
});

const InterviewState = StateBase.extend({
  kind: z.literal("interview"),
  orgId: z.string().min(1),
  nextRound: z.number().int().min(1).max(101),
  capture: InterviewCapture,
}).strict();

const ReconState = StateBase.extend({
  kind: z.literal("recon"),
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  repoUrl: z.string().min(1).max(400),
  report: ReconReport,
  // The injectable paths recon OBSERVED in the repo tree (`ownedInjectionPaths`). The
  // config-injection step reads it to leave a file the repository already owns alone;
  // it is bounded by the injectable path set, so the state stays small. Defaults to
  // empty so a state signed before this field still verifies.
  existingPaths: z.array(z.string().min(1).max(400)).max(16).default([]),
}).strict();

const StatePayload = z.discriminatedUnion("kind", [InterviewState, ReconState]);
export type InterviewStatePayload = z.infer<typeof InterviewState>;
export type ReconStatePayload = z.infer<typeof ReconState>;

export class InvalidOnboardingStateError extends Error {
  override readonly name = "InvalidOnboardingStateError";

  constructor(readonly reason: "missing" | "malformed" | "signature" | "stale" | "binding") {
    super(`invalid onboarding state: ${reason}`);
  }
}

export class OnboardingStateSigner {
  private key: string | undefined;

  constructor(
    private readonly secrets: SecretStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async signInterview(input: { orgId: string; nextRound: number; capture: unknown }): Promise<string> {
    const now = this.now();
    return this.sign({
      version: STATE_VERSION,
      kind: "interview",
      orgId: input.orgId,
      nextRound: input.nextRound,
      capture: InterviewCapture.parse(input.capture),
      issuedAt: now,
      expiresAt: now + STATE_TTL_MS,
    });
  }

  async signRecon(input: {
    orgId: string;
    projectId: string;
    repoUrl: string;
    report: unknown;
    existingPaths?: ReadonlyArray<string>;
  }): Promise<string> {
    const now = this.now();
    return this.sign({
      version: STATE_VERSION,
      kind: "recon",
      orgId: input.orgId,
      projectId: input.projectId,
      repoUrl: input.repoUrl,
      report: ReconReport.parse(input.report),
      existingPaths: [...(input.existingPaths ?? [])],
      issuedAt: now,
      expiresAt: now + STATE_TTL_MS,
    });
  }

  async verifyInterview(raw: unknown, orgId: string): Promise<InterviewStatePayload> {
    const state = await this.verify(raw, "interview");
    if (state.orgId !== orgId) throw new InvalidOnboardingStateError("binding");
    return state;
  }

  async verifyRecon(
    raw: unknown,
    expected: { orgId: string; projectId: string; repoUrl: string },
  ): Promise<ReconStatePayload> {
    const state = await this.verify(raw, "recon");
    if (
      state.orgId !== expected.orgId ||
      state.projectId !== expected.projectId ||
      canonicalRepoUrl(state.repoUrl) !== canonicalRepoUrl(expected.repoUrl)
    ) {
      throw new InvalidOnboardingStateError("binding");
    }
    return state;
  }

  private async sign(payload: InterviewStatePayload | ReconStatePayload): Promise<string> {
    const encoded = encodePayload(payload);
    return `${encoded}.${signEncoded(encoded, await this.resolveKey())}`;
  }

  private async verify(raw: unknown, kind: "interview"): Promise<InterviewStatePayload>;
  private async verify(raw: unknown, kind: "recon"): Promise<ReconStatePayload>;
  private async verify(raw: unknown, kind: "interview" | "recon"): Promise<InterviewStatePayload | ReconStatePayload> {
    if (typeof raw !== "string" || raw === "") throw new InvalidOnboardingStateError("missing");
    const parts = raw.split(".");
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new InvalidOnboardingStateError("malformed");
    }
    const encoded = parts[0];
    const signature = parts[1];
    const expected = signEncoded(encoded, await this.resolveKey());
    if (!constantTimeHexEqual(signature, expected)) throw new InvalidOnboardingStateError("signature");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new InvalidOnboardingStateError("malformed");
    }
    const parsed = StatePayload.safeParse(parsedJson);
    if (!parsed.success) throw new InvalidOnboardingStateError("malformed");
    if (kind === "interview" && parsed.data.kind !== "interview") {
      throw new InvalidOnboardingStateError("malformed");
    }
    if (kind === "recon" && parsed.data.kind !== "recon") {
      throw new InvalidOnboardingStateError("malformed");
    }
    const now = this.now();
    if (parsed.data.issuedAt > now + CLOCK_SKEW_MS || parsed.data.expiresAt <= now) {
      throw new InvalidOnboardingStateError("stale");
    }
    return parsed.data;
  }

  private async resolveKey(): Promise<string> {
    if (this.key !== undefined) return this.key;
    const existing = await this.secrets.get(STATE_SECRET_REF);
    if (existing !== undefined) {
      if (Buffer.byteLength(existing.value, "utf8") < 32)
        throw new Error("onboarding state signing secret is too short");
      this.key = existing.value;
      return existing.value;
    }
    const generated = randomBytes(32).toString("base64url");
    const result = await this.secrets.putCreateOnly({ ref: STATE_SECRET_REF, value: generated });
    if (result.status === "created" || result.status === "already_exists_identical") {
      this.key = generated;
      return generated;
    }
    const afterConflict = await this.secrets.get(STATE_SECRET_REF);
    if (afterConflict === undefined || Buffer.byteLength(afterConflict.value, "utf8") < 32) {
      throw new Error("onboarding state signing secret could not be resolved after create conflict");
    }
    this.key = afterConflict.value;
    return afterConflict.value;
  }
}

function encodePayload(payload: InterviewStatePayload | ReconStatePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signEncoded(encoded: string, key: string): string {
  return createHmac("sha256", key).update(encoded, "utf8").digest("hex");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function canonicalRepoUrl(repoUrl: string): string {
  return repoUrl.replace(/\.git$/u, "");
}
