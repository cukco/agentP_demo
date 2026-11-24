# Cho AI của bạn tự trả tiền qua AgentPay (MCP)

AgentPay có MCP server chạy trên máy bạn (stdio). Bất kỳ ứng dụng AI nào hỗ trợ MCP cũng dùng được: Claude, Cursor, VS Code Copilot, Gemini CLI, Codex CLI, Windsurf, Cline… AI sẽ có 4 tool:

| Tool | Việc AI làm được |
|---|---|
| `agentpay_fetch` | Gọi API trả phí x402. Lần đầu mở phiên ký quỹ (0,5 USDC), các lần sau trả 0,01 USDC/lần. Chỉ trả cho kết quả PASS. |
| `agentpay_open_session` | Mở phiên với hạn mức và thời hạn tự chọn |
| `agentpay_close_session` | Đóng phiên; Keeper chốt tiền, phần chưa dùng hoàn về ví |
| `agentpay_status` | Số dư USDC, luật chi tiêu trên chain, các phiên đang mở |

Mọi dịch vụ (Seller, Verifier, Facilitator, Scorer, Keeper) và Escrow đã chạy sẵn trên Avalanche Fuji. Bạn chỉ cần một ví test có USDC Fuji.

## 1. Cài (khoảng 5 phút)

Cần Git, Node.js 22.13+ và pnpm 10 (`npm i -g pnpm@10`). Không cần Foundry.

```bash
git clone https://github.com/cukco/agentP_demo.git agentpay
cd agentpay
pnpm install --frozen-lockfile
pnpm agentpay:build
pnpm agentpay:wallet
```

`agentpay:wallet` tạo ví agent mới (lưu ở `~/.agentpay/agent-wallet.key`, **chỉ dùng cho testnet**), in địa chỉ ví và **đường dẫn tuyệt đối tới `mcp.js`** để dán vào cấu hình bên dưới. Lệnh không bao giờ in khóa.

Nạp **≥ 1 USDC test** cho địa chỉ đó tại <https://faucet.circle.com> (chọn Avalanche Fuji). AVAX không bắt buộc: Facilitator trả gas mở phiên, Verifier và Keeper trả gas đóng/chốt. Rồi kiểm tra:

```bash
pnpm agentpay:check      # phải ra "Sẵn sàng"
```

Trên Windows, nếu PowerShell chặn `pnpm.ps1` thì dùng `pnpm.cmd`.

## 2. Nối vào AI

Thay `/ABS/PATH/demo/buyer-agent/dist/mcp.js` bằng đường dẫn `agentpay:wallet` in ra (trên Windows dùng dấu `/`, ví dụ `C:/Users/me/agentpay/demo/buyer-agent/dist/mcp.js`). Khởi động lại ứng dụng AI sau khi sửa cấu hình.

**Claude Code** (đã test):
```bash
claude mcp add agentpay -- node /ABS/PATH/demo/buyer-agent/dist/mcp.js
```

**Claude Desktop** — `claude_desktop_config.json` · **Cursor** — `~/.cursor/mcp.json` · **Gemini CLI** — `~/.gemini/settings.json` · Windsurf, Cline và đa số ứng dụng khác dùng cùng mẫu:
```json
{
  "mcpServers": {
    "agentpay": { "command": "node", "args": ["/ABS/PATH/demo/buyer-agent/dist/mcp.js"] }
  }
}
```

**VS Code + GitHub Copilot** (Agent mode) — `.vscode/mcp.json`:
```json
{
  "servers": {
    "agentpay": { "type": "stdio", "command": "node", "args": ["/ABS/PATH/demo/buyer-agent/dist/mcp.js"] }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`:
```toml
[mcp_servers.agentpay]
command = "node"
args = ["/ABS/PATH/demo/buyer-agent/dist/mcp.js"]
```

Nếu ứng dụng không tìm thấy `node`, thay `"node"` bằng đường dẫn đầy đủ (`where node` trên Windows, `which node` trên macOS/Linux).

Chúng tôi đã chạy thật với Claude Code trên Fuji. Các ứng dụng khác dùng cùng chuẩn MCP stdio nên cấu hình như trên; ChatGPT bản web chỉ nhận MCP qua HTTP nên chưa dùng được bản này.

## 3. Thử

1. *"Dùng agentpay kiểm tra ví: số dư, luật chi tiêu, phiên đang mở."*
2. *"Dùng agentpay mua giá AVAX từ https://agentpay-seller.fly.dev/v1/price/AVAX 3 lần, tính trung bình và tổng tiền đã trả."* → mỗi lần một Receipt **PASS**, 0,01 USDC, giá đã được kiểm lại với Chainlink.
3. *"Mở phiên agentpay hạn mức 20 USDC."* → bị chặn: agent chỉ được mở tối đa 1 USDC/phiên.
4. *"Đóng phiên agentpay đang mở và cho tôi session ID."* → khoảng 1 phút sau Keeper chốt: Seller nhận tiền các lượt PASS, phần dư (trừ phí 0,05 USDC) hoàn về ví.

## 4. Con người đặt luật cho agent

Ví agent mới chưa có luật: Escrow chỉ áp luật mặc định tối đa 20 USDC/phiên, chưa kiểm điểm uy tín bên bán. Bạn (chủ ví) nên đặt luật để agent **không tiêu quá tay và chỉ mua bên bán uy tín** — luật nằm trên chain, agent không tự nới được, kể cả khi bị prompt injection.

**Cách 1 — một lệnh trong terminal (không cần MetaMask).** Nạp ~0,01 AVAX cho ví agent ([faucet Fuji](https://build.avax.network/console/primary-network/faucet)) để trả gas giao dịch đăng ký, rồi:

```bash
pnpm agentpay:rules -- --admin 0xVÍ_CỦA_BẠN --per-session 5 --daily 10 --min-score 30
pnpm agentpay:rules        # xem luật hiện tại
```

- `--admin`: ví của bạn (MetaMask), **khác ví agent**. Chỉ ví admin được sửa luật về sau.
- `--per-session`: tối đa USDC mỗi phiên (≤ 20) · `--daily`: tối đa USDC mỗi 24 giờ · `--min-score`: điểm uy tín tối thiểu của bên bán (0–100).

**Cách 2 — Dashboard (MetaMask).** Import khóa ví agent (`~/.agentpay/agent-wallet.key`) vào MetaMask, mạng Avalanche Fuji (chain ID 43113, RPC `https://avalanche-fuji-c-chain-rpc.publicnode.com`), rồi:

```bash
pnpm agentpay:dashboard    # mở http://127.0.0.1:5173 (hoặc bản online https://agentpay-dashboard.fly.dev/app)
```

Tab **Luật người mua** → Kết nối ví (ví agent) → nhập hạn phiên, hạn ngày, điểm tối thiểu, ví admin → **Đăng ký luật** → xác nhận MetaMask.

**Sửa luật về sau** (luôn trên Dashboard, kết nối bằng **ví admin**, nhập địa chỉ ví agent vào ô "Ví người mua" → Xem luật):
- **Siết luật** (giảm hạn mức, tăng điểm): có hiệu lực ngay.
- **Nới luật**: đề xuất, áp dụng sau 24 giờ (có thể hủy trong lúc chờ).
- **Dừng người mua**: chặn mở phiên mới ngay lập tức. Tab **Theo dõi phiên**: xem từng request PASS/FAIL, số dư, điểm uy tín.

Thử lại sau khi có luật: *"Mua giá AVAX từ https://agentpay-low-seller.fly.dev/v1/price/AVAX"* → bên bán này có điểm uy tín 0, Claude nhận `Blocked by on-chain buyer rules · rule: BadScore` và không mất đồng nào.

## Lưu ý

- Mỗi phiên khóa tạm 0,5 USDC trong ký quỹ; phí mỗi phiên 0,05 USDC. Một phiên dùng được tới 50 lượt.
- Dùng ví khác: đặt `AGENTPAY_AGENT_KEY=0x…` (hoặc `AGENTPAY_KEYSTORE_PATH` + `AGENTPAY_KEYSTORE_PASSWORD`) trong cấu hình MCP (`"env": { … }`), hoặc `AGENTPAY_WALLET_FILE` trỏ tới file khóa khác.
- Đổi dịch vụ (ví dụ chạy local): đặt `FACILITATOR_URL`, `SCORER_URL`, `VERIFIER_URL`, `VERIFIER_ADDRESS`, `AGENTPAY_MCP_RPC_URL`.
- Chi tiết tool và bảo mật: [packages/agentpay-mcp/README.md](../packages/agentpay-mcp/README.md).
