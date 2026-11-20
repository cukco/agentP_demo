# AgentPay Buyer SDK

## Chuẩn bị

Làm theo [hướng dẫn cài đặt ở gốc repo](../../README.md#bắt-đầu-từ-máy-sạch) rồi build `pnpm --filter @agentpay/buyer... build`. Chuẩn bị URL thu phí của Seller, `FACILITATOR_URL`, `SCORER_URL` và Escrow tin cậy trên Avalanche Fuji (`43113`). Buyer lấy URL Verifier từ Spec trong phản hồi `402`.

`commonOptions` dưới đây có kiểu `BuyerCommonOptions`. Truyền `chainId`, `publicClient` của viem, `trustedEscrows`, `facilitatorUrl`, `scorerUrl`, `defaultCap`, `defaultExpirySec`, `softPolicy`, `clock` tính bằng Unix giây và adapter `checks` độc lập của bạn. Adapter trả một giá trị `Outcome` sau khi tự kiểm dữ liệu theo Spec. Nếu adapter chỉ hỗ trợ một tập Spec, truyền `supportsSpec` để SDK kiểm hỗ trợ trước lúc ký mở phiên. Demo AVAX có `createPriceChecks` dùng Chainlink. Số tiền dùng `bigint` theo đơn vị nhỏ nhất của USDC, ví dụ `1_000_000n` là 1 USDC.

## Tự động với ví agent

`agentAccount` là viem `LocalAccount` của ví dành riêng cho agent. Tạo `agentWalletClient` với cùng ví, RPC và chain với `commonOptions.publicClient`. Ví này ký mở phiên và Voucher. Khi mở phiên, SDK kiểm `softPolicy` và Escrow áp dụng luật Buyer on-chain.

```ts
import { createAgentPayBuyer } from "@agentpay/buyer";

const buyer = createAgentPayBuyer({
  ...commonOptions,
  mode: "auto",
  account: agentAccount,
  walletClient: agentWalletClient,
});
const { response, receipt } = await buyer.fetchWithReceipt(sellerUrl);
console.log(response.status, receipt?.outcome);
```

`buyer.fetch()` trả `Response`. `buyer.fetchWithReceipt()` trả thêm phần dữ liệu Receipt đã xác minh cho request trả phí, và nhận trần cap tùy chọn làm tham số thứ ba. Nếu Receipt là FAIL hoặc INCONCLUSIVE, xử lý `BuyerReceiptError` để lấy mã lý do. Dùng `buyer.close(sessionId)` để yêu cầu Verifier đóng phiên. Khi gặp HTTP `402`, `fetch` đọc điều khoản rồi tự mở hoặc tái sử dụng một phiên đủ cap.

## Duyệt một phiên bằng MetaMask

Dùng `createAgentPayBuyer` với `mode: "approve"`, `buyerAddress` là địa chỉ ví công khai trên Avalanche Fuji và `onApprovalUrl` để chuyển liên kết một lần cho người giữ ví. Build `@agentpay/buyer...` để đóng gói trang duyệt. Cấu hình Escrow, RPC, Facilitator, Scorer và adapter `checks` như chế độ `auto`.

```ts
const buyer = createAgentPayBuyer({
  ...commonOptions,
  mode: "approve",
  buyerAddress: mainWalletAddress,
  onApprovalUrl: showLinkToWalletOwner,
});
const sessionId = await buyer.openSession(sellerUrl, { cap: 1_000_000n, expirySec: 3600 });
```

`onApprovalUrl` nhận link riêng tư dẫn tới `127.0.0.1`. Người giữ ví mở link trên Chrome hoặc Edge có MetaMask, đối chiếu điều khoản trên trang và xác nhận chữ ký EIP-3009. Link hết hiệu lực sau một lần duyệt hoặc từ chối, hoặc sau 5 phút. `buyer.fetch()` dùng lại khóa Voucher của phiên khi còn hiệu lực. Nếu chủ động gọi `buyer.close()`, MetaMask ký một `CloseRequest` riêng theo giao diện Verifier.

JavaScript không thể xóa chắc chắn dữ liệu khóa khỏi bộ nhớ ngay lập tức. SDK giữ khóa Voucher trong RAM và bỏ tham chiếu khi hết hạn, khi dừng phiên hoặc khi nhận kết quả đang đóng. Store chỉ lưu hồ sơ phiên và bằng chứng đã ký. Sau khi khởi động lại, mở phiên mới để có khóa Voucher mới.

Khi kết quả settle ở chế độ `approve` chưa rõ, SDK đợi đến lúc authorization hết hạn để tránh mở lại sớm. Authorization có hiệu lực tối đa 120 giây. Nếu sai lệch dữ liệu khiến SDK dừng một phiên, người giữ ví có thể gọi `buyer.close()` để ký yêu cầu đóng, hoặc phiên tiếp tục theo cơ chế hết hạn của giao thức.

## Đăng ký luật Buyer với registerBuyer

Với ví auto, đưa `BUYER_AUTO_PRIVATE_KEY` và `FUJI_RPC_URL_1` vào môi trường của terminal từ nơi lưu bí mật. Đặt `AGENTPAY_ESCROW` khi dùng deployment khác mặc định, kể cả Anvil. Ví đăng ký cần AVAX để trả gas. Tạo file `buyer-policy.json` theo mẫu này. Giá trị tiền là chuỗi thập phân theo đơn vị nhỏ nhất của USDC.

```json
{
  "maxPerSession": "5000000",
  "dailyCap": "10000000",
  "minScore": 30,
  "paused": false,
  "sellerAllowlistOn": false
}
```

Chạy từ gốc repo, với `$admin` là địa chỉ công khai của ví quản trị và file policy nằm ở gốc repo.

```powershell
$policy = (Resolve-Path .\buyer-policy.json).Path
pnpm --filter @agentpay/buyer run setup $admin $policy
```

Dùng `run setup` để pnpm gọi script của package. Script gửi `registerBuyer`, đợi giao dịch thành công rồi in lại luật đọc trên contract. Với ví chính dùng `approve`, ký giao dịch `registerBuyer` bằng MetaMask qua dashboard khi dashboard sẵn sàng. Ví agent có thể dùng hạn mức cap thấp hơn qua `softPolicy`.

## Cài đặt an toàn

- Chỉ cấp bốn tool AgentPay cho agent. Giữ công cụ chuyển tiền và ký giao dịch tổng quát ở ngoài quyền của agent.
- Với `auto`, giữ khóa trong tiến trình MCP hoặc dịch vụ ký riêng. Giới hạn quyền đọc file khóa và quyền chạy mã trong môi trường agent.
- Dùng ví agent riêng có số dư nhỏ. Giữ tiền chính trong ví do người quản lý và nạp dần theo nhu cầu. Luật Buyer áp dụng cho các khoản chi đi qua Escrow AgentPay.
- Với `approve`, giữ ví chính trong MetaMask và chỉ mở link duyệt localhost trên máy đang chạy SDK. Đối chiếu Seller, cap, phí và Escrow trước khi ký.

## Dùng qua MCP

MCP hiện chạy Buyer `auto` qua stdio. Cấu hình khóa hoặc Ethereum V3 keystore ở tiến trình MCP. Có thể gọi `agentpay_status` để xem số dư và luật rồi thử `agentpay_fetch` với URL Seller và `maxCapUsd` nhỏ. [Cấu hình Claude Desktop và bốn tool](../agentpay-mcp/README.md)

## Bàn giao H40 cho D

Chạy từ gốc repo sau khi build contract bằng Foundry. Anvil cần có trong PATH hoặc được chỉ định qua `ANVIL_BIN`.

```powershell
pnpm --filter @agentpay/buyer... build
pnpm --filter @agentpay/buyer exec playwright install chromium
$env:APPROVE_PLAYWRIGHT = '1'
pnpm --filter @agentpay/buyer test approve-browser.test.ts
```

Có thể đặt `PLAYWRIGHT_CHROMIUM_EXECUTABLE` trỏ tới Edge hoặc Chrome hiện có. Bài test dùng provider giả trong trình duyệt và Escrow thật trên Anvil local với chain ID `43113`. Nó kiểm thay cap hiển thị bị chặn trước khi gọi ví, đổi mạng, mở phiên sau một chữ ký từ ví chính, Voucher ký bằng khóa riêng của phiên và không dùng lại khóa sau expiry.

Kết quả trên Edge headless và Anvil local. Mở phiên thành công sau khi provider chuyển từ chain ID `1` sang `43113`. Request trả Receipt `PASS`. Sau expiry SDK không gửi thêm Voucher cho phiên cũ. Yêu cầu đóng được ví chính ký riêng và Escrow chuyển sang `CLOSING`. Các ca unit xác nhận timeout đúng 5 phút, listener đóng và token không dùng lại được.

## Kết quả xác nhận bằng MetaMask thật trên Fuji

**Hoãn kiểm thử MetaMask thật trên Fuji.** C7 được bàn giao với kết quả Playwright trên Anvil. Lượt Fuji cần URL Seller, Facilitator và Scorer đang chạy cùng deployment, cùng người giữ ví `buyer-main` để duyệt chữ ký.

Khi chạy, ghi `sessionId` và hash giao dịch `openWithAuthorization`. Xác nhận trên Fuji chain ID `43113` rằng phiên ở trạng thái `OPEN`, `buyer` là ví `buyer-main`, `cap` đúng với màn duyệt và `voucherSigner` khác ví trả tiền. Chỉ lưu ID phiên và hash giao dịch trong phần kết quả.
