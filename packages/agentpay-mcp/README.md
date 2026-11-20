# AgentPay MCP

Server chạy Buyer SDK ở chế độ `auto` qua stdio. Build Core, Buyer và MCP từ gốc repo.

```powershell
pnpm --filter @agentpay/mcp... build
```

## Claude Desktop

Thêm mục `agentpay` vào `mcpServers` trong `claude_desktop_config.json`. Điền đường dẫn tuyệt đối tới `node.exe`, file cấu hình local và entry point đã build. Khởi động lại Claude Desktop sau khi lưu.

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "--env-file=C:\\Users\\Admin\\agentpay-mcp.env",
        "D:\\D\\agentpay-1\\packages\\agentpay-mcp\\dist\\index.js"
      ]
    }
  }
}
```

Trong `agentpay-mcp.env` đặt `FUJI_RPC_URL_1`, `FACILITATOR_URL`, `SCORER_URL` và một nguồn khóa:

- `AGENTPAY_AGENT_KEY` cho khóa ví agent dạng hex `0x…`.
- `AGENTPAY_KEYSTORE_PATH` và `AGENTPAY_KEYSTORE_PASSWORD` cho Ethereum V3 keystore.

`AGENTPAY_ESCROW` mặc định dùng deployment Fuji của repo. Khi dùng Anvil với chain ID `43113`, trỏ RPC, Escrow và các service vào môi trường local. Mặc định cap là 1 USDC, trần cap là 1 USDC và giá tối đa mỗi request là 0,01 USDC. Có thể cấu hình lần lượt qua `AGENTPAY_DEFAULT_CAP_USD`, `AGENTPAY_MAX_CAP_USD` và `AGENTPAY_MAX_PRICE_USD`.

Server mặc định tự kiểm các Spec `file` chỉ dùng `hash-match`. Với Spec khác, trỏ `AGENTPAY_CHECKS_MODULE` vào module local có export `checks` theo kiểu `BuyerOptions["checks"]`. Module có thể export thêm `supportsSpec` để từ chối Spec không hỗ trợ trước khi mở phiên.

| Tool | Kết quả |
|---|---|
| `agentpay_fetch` | HTTP status, nội dung text/JSON và tóm tắt Receipt đã xác minh. Body nhị phân trả `null`. `maxCapUsd` giới hạn cả phiên mở mới lẫn phiên tái sử dụng. |
| `agentpay_open_session` | ID phiên mới với cap và thời hạn yêu cầu. |
| `agentpay_close_session` | Xác nhận SDK đã xử lý yêu cầu đóng phiên. |
| `agentpay_status` | Số dư USDC, luật Buyer trên chain và các phiên mở trong store. Truyền `sessionId` để xem một phiên cụ thể. `usedUsdc` là số tiền tối đa đã ký qua Voucher, quyết toán dựa trên verdict. |

## Kiểm thử

Sau khi build contract và có `anvil` trong PATH hoặc đặt `ANVIL_BIN`, chạy `pnpm --filter @agentpay/mcp test`. `mcp.test.ts` dùng MCP client trong bộ nhớ. `stdio-anvil.test.ts` khởi chạy `dist/index.js` qua stdio, dùng Ethereum V3 keystore thử nghiệm và gọi Buyer trên Anvil local.

Kết quả chạy bằng MCP SDK Client qua stdio trên Anvil local. Client thấy đúng 4 tool. `agentpay_fetch` trả HTTP 200 và Receipt `PASS`, seq 1, giá 0,01 USDC. Trần 0,5 USDC tạo phiên mới với cap 0,5 USDC dù đã có phiên cap 1 USDC. Seller SDK, Facilitator và Escrow chạy thật trong bài test, còn Scorer và Verifier relay dùng fixture ký theo giao diện đã chốt. Claude Desktop chưa được thử trên máy này.
