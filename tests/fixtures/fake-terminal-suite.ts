import test from "node:test";

test("terminal test command remains alive long enough to bind its process identity", async () => {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
});
