import { passwordWork } from "../src/auth";

// Real hashes take ITERATIONS PBKDF2 iterations (100,000 on the free plan); the password tests put that back.
passwordWork.iterations = 1_000;
