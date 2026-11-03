import { createClient } from "@supabase/supabase-js";

// NOT: Next.js NEXT_PUBLIC_* değerlerini build sırasında koda gömer; bu yüzden
// process.env erişimleri literal kalmalı (dinamik anahtar kullanılamaz).
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const supabaseKey = (
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)?.trim();

if (!supabaseUrl) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL eksik.");
}

if (!supabaseKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY eksik (eski adı: NEXT_PUBLIC_SUPABASE_ANON_KEY)."
  );
}

assertKeyMatchesProject(supabaseUrl, supabaseKey);

export const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * URL ile key'in aynı projeye ait olduğunu ve key'in tarayıcıya konulabilecek
 * türde olduğunu doğrular. Yanlış/eski proje key'i sessizce "Failed to fetch"
 * veya 401 üretmek yerine burada anlaşılır bir hata verir.
 */
function assertKeyMatchesProject(url: string, key: string) {
  if (key.startsWith("sb_secret_")) {
    throw new Error(
      "Secret key istemciye konulamaz. sb_publishable_... key'ini kullan."
    );
  }

  if (key.startsWith("sb_publishable_")) return;

  // Legacy JWT anon key: payload içindeki ref ve role'ü kontrol et.
  const parts = key.split(".");
  if (parts.length !== 3) {
    throw new Error("Supabase key biçimi geçersiz (eksik/bozuk kopyalanmış).");
  }

  let payload: { ref?: string; role?: string };
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
  } catch {
    throw new Error("Supabase key çözümlenemedi (eksik/bozuk kopyalanmış).");
  }

  if (payload.role !== "anon") {
    throw new Error(
      `İstemcide yalnızca anon/publishable key kullanılabilir (bulunan role: ${payload.role}).`
    );
  }

  const host = new URL(url).hostname;
  if (payload.ref && host.endsWith(".supabase.co") && !host.startsWith(`${payload.ref}.`)) {
    throw new Error(
      `Supabase key "${payload.ref}" projesine ait ama URL "${host}". İkisi aynı projeden olmalı.`
    );
  }
}
