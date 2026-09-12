import { describe, expect, it } from "vitest";
import { assertValidPassword, isValidPassword } from "./password-policy";

describe("signup password policy", () => {
  it.each(["Abcdefg1", "LongerPassword123", "GoodPass1!", "Abc def1"])("accepts %s", (password) => {
    expect(isValidPassword(password)).toBe(true);
    expect(() => assertValidPassword(password)).not.toThrow();
  });
  it.each(["", "Abcdef1", "abcdef12", "ABCDEF12", "Abcdefgh", "12345678", "        "])("rejects %s", (password) => {
    expect(isValidPassword(password)).toBe(false);
    expect(() => assertValidPassword(password)).toThrow("at least 8 characters");
  });
});
