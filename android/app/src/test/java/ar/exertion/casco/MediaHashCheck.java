package ar.exertion.casco;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.util.Map;

/**
 * Sin framework: javac MediaHash.java MediaHashCheck.java && java -ea ar.exertion.casco.MediaHashCheck
 */
public class MediaHashCheck {
    static void eq(Object exp, Object got, String what) {
        if (exp == null ? got != null : !exp.equals(got)) {
            throw new AssertionError(what + ": esperado " + exp + " obtenido " + got);
        }
    }

    public static void main(String[] a) throws Exception {
        File dir = Files.createTempDirectory("mh").toFile();
        File f = new File(dir, "abc.jpg");
        try (FileOutputStream o = new FileOutputStream(f)) { o.write("abc".getBytes("US-ASCII")); }
        String abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        eq(abc, MediaHash.sha256(f), "vector abc");

        Map<String, Object> m = MediaHash.fields(f, 1_700_000_000_123L);
        eq("[sha256, hash_alg, size, captured_at]", m.keySet().toString(), "claves");
        eq(abc, m.get("sha256"), "payload sha");
        eq("sha256", m.get("hash_alg"), "alg");
        eq(3L, m.get("size"), "size");
        eq("2023-11-14T22:13:20.123Z", m.get("captured_at"), "captured_at UTC");

        // archivo > 64 KB (varias vueltas del buffer): vector conocido de 1.000.000 x 'a'
        File big = new File(dir, "big.mp4");
        try (FileOutputStream o = new FileOutputStream(big)) {
            byte[] chunk = new byte[1000];
            java.util.Arrays.fill(chunk, (byte) 'a');
            for (int i = 0; i < 1000; i++) o.write(chunk);
        }
        eq("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0", MediaHash.sha256(big), "1M a");

        // falla: archivo inexistente -> sin campos, sin excepcion
        eq(0, MediaHash.fields(new File(dir, "nope.jpg"), 1L).size(), "falla = vacio");
        System.out.println("MediaHashCheck OK");
    }
}
