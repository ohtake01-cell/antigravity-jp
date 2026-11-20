import { describe, it, expect } from "vitest";
import {
  classifyAutoPlannerType,
  resolvePlannerType,
} from "../utils/autoPlanner";

describe("autoPlanner", () => {
  it("keeps everyday bug fixes, questions, and immediate-action prompts on Fast (conversational)", () => {
    expect(classifyAutoPlannerType("このバグを直して")).toBe("conversational");
    expect(classifyAutoPlannerType("実行モードにFastとPlanがあるけど、これは何かな？")).toBe("conversational");
    expect(classifyAutoPlannerType("止まらずどんどん進めていいよ")).toBe("conversational");
    expect(
      classifyAutoPlannerType("ゼロから新しいシステムを作るけど、止まらず進めていいよ"),
    ).toBe("conversational");
  });

  it("switches greenfield builds, full architecture designs, and explicit plan requests to Plan (planning)", () => {
    expect(
      classifyAutoPlannerType("ゼロから新しい認証基盤システムを設計・構築したい"),
    ).toBe("planning");
    expect(
      classifyAutoPlannerType("まずは実装計画を立てて方針を見せてほしい"),
    ).toBe("planning");
    expect(
      classifyAutoPlannerType("大規模なリファクタリングと全体設計の見直しを行う"),
    ).toBe("planning");
  });

  it("respects explicit Fast or Plan override while resolving Auto dynamically", () => {
    expect(
      resolvePlannerType("conversational", "ゼロから新しい認証システムを構築したい"),
    ).toBe("conversational");
    expect(resolvePlannerType("planning", "このバグ直して")).toBe("planning");
    expect(
      resolvePlannerType("auto", "ゼロから新しい認証システムを構築したい"),
    ).toBe("planning");
    expect(resolvePlannerType("auto", "このバグ直して")).toBe("conversational");
  });
});
