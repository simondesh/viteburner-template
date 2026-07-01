// Scratch reference data for coding-contract solving. Not a runnable script
// (no main); kept as valid TS exports so it compiles — a bare `name = {...}`
// statement here is invalid TypeScript and its parse error silently masks every
// other type error in the project.

/** Observed frequency of contract types encountered (running tally). */
export const currentFrequency: Record<string, number> = {
    'Total Ways to Sum': 16,
    'Find Largest Prime Factor': 16,
    'Subarray with Maximum Sum': 18,
    'Algorithmic Stock Trader I': 6,
    'Encryption I: Caesar Cipher': 13,
};

/** Every coding-contract type in the game. */
export const allContracts: string[] = [
    'Find Largest Prime Factor',
    'Subarray with Maximum Sum',
    'Total Ways to Sum',
    'Total Ways to Sum II',
    'Spiralize Matrix',
    'Array Jumping Game',
    'Array Jumping Game II',
    'Merge Overlapping Intervals',
    'Generate IP Addresses',
    'Algorithmic Stock Trader I',
    'Algorithmic Stock Trader II',
    'Algorithmic Stock Trader III',
    'Algorithmic Stock Trader IV',
    'Minimum Path Sum in a Triangle',
    'Unique Paths in a Grid I',
    'Unique Paths in a Grid II',
    'Shortest Path in a Grid',
    'Sanitize Parentheses in Expression',
    'Find All Valid Math Expressions',
    'HammingCodes: Integer to Encoded Binary',
    'HammingCodes: Encoded Binary to Integer',
    'Proper 2-Coloring of a Graph',
    'Compression I: RLE Compression',
    'Compression II: LZ Decompression',
    'Compression III: LZ Compression',
    'Encryption I: Caesar Cipher',
    'Encryption II: Vigenère Cipher',
    'Square Root',
    'Total Number of Primes',
    'Largest Rectangle in a Matrix',
];
