# AgentPay Seller SDK

## Tích hợp vào Hono trong 5 dòng

Chuẩn bị `sellerOptions` theo kiểu `SellerOptions` và truyền nó vào app. Gắn middleware trước route trả giá.

```ts
import { Hono } from "hono";
import { createAgentPaySeller } from "@agentpay/seller";
const app = new Hono();
app.use("/v1/price/AVAX", createAgentPaySeller(sellerOptions).middleware());
app.get("/v1/price/AVAX", async c => c.json(await readAvaxPrice()));
```

`readAvaxPrice()` là handler ứng dụng, trả `{ symbol: "AVAX", price, timestamp }`, với timestamp Unix giây. Chạy `serve({ fetch: app.fetch, port: 4021 })` ở entry point. Khi chạy service lâu dài, giữ tham chiếu tới instance Seller để gọi `seller.stop()` lúc dừng. Dùng `createFileSellerStore(directory)` nếu cần giữ Voucher và checkpoint qua lần khởi động lại.

### Cấu hình

- `account`, `walletClient` và `publicClient` cùng trỏ tới ví Seller và chain thanh toán. Với Fuji, đặt `chainId: 43113` và địa chỉ Escrow cùng deployment của Verifier.
- `sellerAgentId` là ID ERC-8004 liên kết với ví Seller và tên miền API. `pricePerRequest` và giới hạn cap trong `terms` tính bằng đơn vị nhỏ nhất của USDC. `10_000n` tương ứng 0,01 USDC.
- `spec` mô tả kiểu dữ liệu và điều kiện kiểm. `verifierUrl` trỏ tới Verifier xử lý phiên. Truyền `clock: () => Math.floor(Date.now() / 1000)` khi chạy thật.

Một GET chưa có Voucher phải trả HTTP `402` với header `PAYMENT-REQUIRED`. Sau khi Buyer mở phiên, Verifier chuyển Voucher đến middleware. Seller ký Delivery trên chính byte mà handler trả về.

## Chạy ví dụ hoàn chỉnh

App AVAX đã cấu hình SDK, đọc Chainlink và có công tắc lệch giá cho buổi diễn tập. Từ gốc repo, build và chạy với môi trường trong [hướng dẫn demo](../../demo/README.md).

```powershell
pnpm --filter @agentpay-demo/seller-avax-price... build
pnpm --filter @agentpay-demo/seller-avax-price start
curl.exe -i http://127.0.0.1:4021/v1/price/AVAX
```

Kỳ vọng GET trả `402` và công bố `agentpay-session` trên `eip155:43113`.
