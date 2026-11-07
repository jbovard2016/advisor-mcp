import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "../src/redact.js";

test("redacts common credential formats", () => {
  const openAIKey = ["sk", "proj", "A".repeat(28)].join("-");
  const githubToken = ["ghp", "B".repeat(36)].join("_");
  const awsKey = ["AKIA", "C".repeat(16)].join("");
  const bearer = "D".repeat(32);
  const input = [
    `OPENAI_API_KEY=${openAIKey}`,
    `token: ${githubToken}`,
    `Authorization: Bearer ${bearer}`,
    awsKey,
    "password=correct-horse-battery-staple",
  ].join("\n");

  const result = redactSecrets(input);
  assert.ok(result.count >= 5);
  assert.doesNotMatch(result.text, new RegExp(openAIKey));
  assert.doesNotMatch(result.text, new RegExp(githubToken));
  assert.doesNotMatch(result.text, new RegExp(awsKey));
  assert.doesNotMatch(result.text, new RegExp(bearer));
  assert.doesNotMatch(result.text, /correct-horse-battery-staple/);
  assert.match(result.text, /\[REDACTED/);
});

test("leaves ordinary code unchanged", () => {
  const input = "const password = userInput; // read from config\nreturn apiKey;";
  const result = redactSecrets(input);
  assert.equal(result.text, input);
  assert.equal(result.count, 0);
});

test("redacts JSON tool inputs and configured secrets before clipping", () => {
  const result = redactSecrets('{"password":"correct-horse-battery-staple","api_key":"short-key"}', ["short-key"]);
  assert.doesNotMatch(result.text, /correct-horse|short-key/);
  assert.equal(result.count, 2);
});
