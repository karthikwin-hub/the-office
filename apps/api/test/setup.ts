import { passwordWork } from "../src/auth";

// Real hashes take 600,000 PBKDF2 iterations, about 150 ms each here; the password tests put that back.
passwordWork.iterations = 1_000;
