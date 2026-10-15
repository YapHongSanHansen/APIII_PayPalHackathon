import { receiptPublicKeyPem } from "@/lib/crypto";

export const dynamic = "force-dynamic";

// Ed25519 public key. Verify: signature over canonical JSON (sorted keys) of the receipt payload fields.
export async function GET() {
  return new Response(receiptPublicKeyPem(), { headers: { "content-type": "application/x-pem-file" } });
}
