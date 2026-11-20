import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PolicyForm } from "../src/components/PolicyForm.js";
afterEach(cleanup);
it("does not submit invalid amounts", async () => {
  const submit = vi.fn(); render(<PolicyForm disabled={false} submit={submit} />);
  fireEvent.change(screen.getByLabelText("Hạn mỗi phiên (USDC)"), { target: { value: "21" } });
  fireEvent.click(screen.getByRole("button", { name: "Đăng ký luật" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("≤ $20"); expect(submit).not.toHaveBeenCalled();
});
it("shows a 24-hour proposal when any constraint loosens", async () => {
  const submit = vi.fn().mockResolvedValue(undefined);
  render(<PolicyForm disabled={false} submit={submit} current={{ maxPerSession: 1000000n, dailyCap: 5000000n, minScore: 50, paused: false, sellerAllowlistOn: false }} />);
  fireEvent.change(screen.getByLabelText("Hạn mỗi phiên (USDC)"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Đề xuất nới luật (24 giờ)" }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ maxPerSession: 2000000n })));
});
