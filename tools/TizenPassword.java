// Prints the password in the environment variable named by the first argument, encrypted the way the Tizen CLI
// reads passwords from a signing profile (CipherUtil, its own fixed-key cipher). Used by package-tv.sh:
//   java -cp "$TIZEN_HOME/tools/ide/lib-ncli/*" tools/TizenPassword.java AUTHOR_PASSWORD
// Reading it from the environment keeps the password off the command line. The value is printed on a line
// starting "TIZENPW:", because Tizen's logging library can print to standard output as well.
public class TizenPassword {
    public static void main(String[] args) throws Exception {
        String value = System.getenv(args[0]);
        if (value == null || value.isEmpty()) {
            System.err.println("TizenPassword: " + args[0] + " is not set");
            System.exit(1);
        }
        String encrypted = org.tizen.common.util.CipherUtil.getEncryptedString(value);
        if (!value.equals(org.tizen.common.util.CipherUtil.getDecryptedString(encrypted))) {
            System.err.println("TizenPassword: encryption check failed");
            System.exit(1);
        }
        System.out.println("TIZENPW:" + encrypted);
    }
}
