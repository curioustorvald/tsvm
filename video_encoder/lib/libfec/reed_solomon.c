/**
 * Reed-Solomon (255,223) Codec Implementation
 *
 * Standard RS code over GF(2^8) for TAV-DT forward error correction.
 *
 * Created by CuriousTorvald and Claude on 2025-12-09.
 */

#include "reed_solomon.h"
#include <string.h>
#include <stdio.h>

// =============================================================================
// Galois Field GF(2^8) Arithmetic
// =============================================================================

// Primitive polynomial: x^8 + x^4 + x^3 + x^2 + 1 = 0x11D
#define GF_PRIMITIVE 0x11D
#define GF_SIZE      256
#define GF_MAX       255

// Lookup tables for GF(2^8) arithmetic
static uint8_t gf_exp[512];  // Anti-log table (doubled for easy modular reduction)
static uint8_t gf_log[256];  // Log table
static uint8_t gf_generator[RS_PARITY_SIZE + 1];  // Generator polynomial coefficients

static int rs_initialized = 0;

// Initialize GF(2^8) exp/log tables
static void init_gf_tables(void) {
    uint16_t x = 1;

    for (int i = 0; i < GF_MAX; i++) {
        gf_exp[i] = (uint8_t)x;
        gf_log[x] = (uint8_t)i;

        // Multiply by alpha (primitive element = 2)
        x <<= 1;
        if (x & 0x100) {
            x ^= GF_PRIMITIVE;
        }
    }

    // Double the exp table for easy modular reduction
    for (int i = GF_MAX; i < 512; i++) {
        gf_exp[i] = gf_exp[i - GF_MAX];
    }

    // gf_log[0] is undefined, set to 0 for safety
    gf_log[0] = 0;
}

// GF multiplication
static inline uint8_t gf_mul(uint8_t a, uint8_t b) {
    if (a == 0 || b == 0) return 0;
    return gf_exp[gf_log[a] + gf_log[b]];
}

// GF division
static inline uint8_t gf_div(uint8_t a, uint8_t b) {
    if (a == 0) return 0;
    if (b == 0) return 0;  // Division by zero - shouldn't happen
    return gf_exp[gf_log[a] + GF_MAX - gf_log[b]];
}

// GF power
static inline uint8_t gf_pow(uint8_t a, int n) {
    if (n == 0) return 1;
    if (a == 0) return 0;
    return gf_exp[(gf_log[a] * n) % GF_MAX];
}

// GF inverse
static inline uint8_t gf_inv(uint8_t a) {
    if (a == 0) return 0;
    return gf_exp[GF_MAX - gf_log[a]];
}

// =============================================================================
// Generator Polynomial
// =============================================================================

// Build generator polynomial: g(x) = (x - alpha^0)(x - alpha^1)...(x - alpha^31)
static void init_generator(void) {
    // Start with g(x) = 1
    gf_generator[0] = 1;
    for (int i = 1; i <= RS_PARITY_SIZE; i++) {
        gf_generator[i] = 0;
    }

    // Multiply by (x - alpha^i) for i = 0 to 31
    for (int i = 0; i < RS_PARITY_SIZE; i++) {
        uint8_t alpha_i = gf_exp[i];  // alpha^i

        // Multiply current polynomial by (x - alpha^i)
        for (int j = RS_PARITY_SIZE; j > 0; j--) {
            gf_generator[j] = gf_generator[j - 1] ^ gf_mul(gf_generator[j], alpha_i);
        }
        gf_generator[0] = gf_mul(gf_generator[0], alpha_i);
    }
}

// =============================================================================
// Public API
// =============================================================================

void rs_init(void) {
    if (rs_initialized) return;

    init_gf_tables();
    init_generator();
    rs_initialized = 1;
}

size_t rs_encode(const uint8_t *data, size_t data_len, uint8_t *output) {
    if (!rs_initialized) rs_init();

    // Validate input
    if (data_len > RS_DATA_SIZE) {
        data_len = RS_DATA_SIZE;
    }

    // Copy data to output
    memcpy(output, data, data_len);

    // Initialize parity bytes to zero
    memset(output + data_len, 0, RS_PARITY_SIZE);

    // Create padded message polynomial (RS_DATA_SIZE + RS_PARITY_SIZE coefficients)
    // Message is shifted to leave room for parity (systematic encoding)
    uint8_t msg[RS_BLOCK_SIZE];
    memset(msg, 0, sizeof(msg));
    memcpy(msg, data, data_len);

    // Polynomial division: compute remainder of msg(x) * x^32 / g(x)
    uint8_t remainder[RS_PARITY_SIZE];
    memset(remainder, 0, RS_PARITY_SIZE);

    for (size_t i = 0; i < data_len; i++) {
        uint8_t coef = msg[i] ^ remainder[0];

        // Shift remainder
        memmove(remainder, remainder + 1, RS_PARITY_SIZE - 1);
        remainder[RS_PARITY_SIZE - 1] = 0;

        // Subtract coef * g(x) from remainder
        if (coef != 0) {
            for (int j = 0; j < RS_PARITY_SIZE; j++) {
                remainder[j] ^= gf_mul(gf_generator[RS_PARITY_SIZE - 1 - j], coef);
            }
        }
    }

    // Append parity to output
    memcpy(output + data_len, remainder, RS_PARITY_SIZE);

    return data_len + RS_PARITY_SIZE;
}

// =============================================================================
// Berlekamp-Massey Decoder
// =============================================================================

// Compute syndromes S_i = r(alpha^i) for i = 0..31
static void compute_syndromes(const uint8_t *r, size_t len, uint8_t *syndromes) {
    for (int i = 0; i < RS_PARITY_SIZE; i++) {
        syndromes[i] = 0;
        for (size_t j = 0; j < len; j++) {
            syndromes[i] ^= gf_mul(r[j], gf_pow(gf_exp[i], (int)(len - 1 - j)));
        }
    }
}

// Berlekamp-Massey algorithm to find error locator polynomial
static int berlekamp_massey(const uint8_t *syndromes, uint8_t *sigma, int *sigma_deg) {
    uint8_t C[RS_PARITY_SIZE + 1];  // Connection polynomial
    uint8_t B[RS_PARITY_SIZE + 1];  // Previous connection polynomial
    int L = 0;  // Current length of LFSR
    int m = 1;  // Number of steps since last update
    uint8_t b = 1;  // Previous discrepancy

    // Initialize: C(x) = 1, B(x) = 1
    memset(C, 0, sizeof(C));
    memset(B, 0, sizeof(B));
    C[0] = 1;
    B[0] = 1;

    for (int n = 0; n < RS_PARITY_SIZE; n++) {
        // Compute discrepancy
        uint8_t d = syndromes[n];
        for (int i = 1; i <= L; i++) {
            d ^= gf_mul(C[i], syndromes[n - i]);
        }

        if (d == 0) {
            // No update needed
            m++;
        } else if (2 * L <= n) {
            // Update both C and L
            uint8_t T[RS_PARITY_SIZE + 1];
            memcpy(T, C, sizeof(T));

            uint8_t factor = gf_div(d, b);
            for (int i = 0; i <= RS_PARITY_SIZE - m; i++) {
                C[i + m] ^= gf_mul(factor, B[i]);
            }

            L = n + 1 - L;
            memcpy(B, T, sizeof(B));
            b = d;
            m = 1;
        } else {
            // Only update C
            uint8_t factor = gf_div(d, b);
            for (int i = 0; i <= RS_PARITY_SIZE - m; i++) {
                C[i + m] ^= gf_mul(factor, B[i]);
            }
            m++;
        }
    }

    // Copy result
    memcpy(sigma, C, RS_PARITY_SIZE + 1);
    *sigma_deg = L;

    return L;
}

// Chien search: find error positions (roots of sigma)
static int chien_search(const uint8_t *sigma, int sigma_deg, size_t n, uint8_t *positions, int *num_errors) {
    *num_errors = 0;

    // Evaluate sigma(alpha^(-i)) for i = 0 to n-1
    for (size_t i = 0; i < n; i++) {
        uint8_t eval = 0;
        for (int j = 0; j <= sigma_deg; j++) {
            // sigma(alpha^(-i)) = sum of sigma[j] * alpha^(-i*j)
            int exp = (GF_MAX - (int)((i * j) % GF_MAX)) % GF_MAX;
            eval ^= gf_mul(sigma[j], gf_exp[exp]);
        }

        if (eval == 0) {
            // Found a root - error at position n-1-i
            positions[*num_errors] = (uint8_t)(n - 1 - i);
            (*num_errors)++;
        }
    }

    // Check if we found the expected number of errors
    return (*num_errors == sigma_deg) ? 0 : -1;
}

// Compute formal derivative of polynomial
static void poly_derivative(const uint8_t *poly, int deg, uint8_t *deriv) {
    for (int i = 0; i < deg; i++) {
        // Derivative of x^(i+1) is (i+1) * x^i
        // In GF(2^m), coefficient is 1 if (i+1) is odd, 0 if even
        deriv[i] = ((i + 1) & 1) ? poly[i + 1] : 0;
    }
}

// Forney algorithm: compute error values
static void forney(const uint8_t *syndromes, const uint8_t *sigma, int sigma_deg,
                   const uint8_t *positions, int num_errors, size_t n, uint8_t *errors) {
    // Compute error evaluator polynomial omega(x) = S(x) * sigma(x) mod x^2t
    uint8_t omega[RS_PARITY_SIZE + 1];
    memset(omega, 0, sizeof(omega));

    for (int i = 0; i < RS_PARITY_SIZE; i++) {
        for (int j = 0; j <= sigma_deg && i - j >= 0; j++) {
            omega[i] ^= gf_mul(syndromes[i - j], sigma[j]);
        }
    }

    // Compute formal derivative of sigma
    uint8_t sigma_prime[RS_PARITY_SIZE];
    poly_derivative(sigma, sigma_deg, sigma_prime);

    // Compute error values using Forney formula
    for (int i = 0; i < num_errors; i++) {
        uint8_t pos = positions[i];
        uint8_t Xi = gf_exp[n - 1 - pos];  // alpha^(n-1-pos)
        uint8_t Xi_inv = gf_inv(Xi);

        // Evaluate omega at Xi_inv
        uint8_t omega_val = 0;
        for (int j = 0; j < RS_PARITY_SIZE; j++) {
            omega_val ^= gf_mul(omega[j], gf_pow(Xi_inv, j));
        }

        // Evaluate sigma' at Xi_inv
        uint8_t sigma_prime_val = 0;
        for (int j = 0; j < sigma_deg; j++) {
            sigma_prime_val ^= gf_mul(sigma_prime[j], gf_pow(Xi_inv, j));
        }

        // Error value: e_i = Xi * omega(Xi_inv) / sigma'(Xi_inv)
        errors[i] = gf_mul(Xi, gf_div(omega_val, sigma_prime_val));
    }
}

int rs_decode(uint8_t *data, size_t data_len) {
    if (!rs_initialized) rs_init();

    size_t total_len = data_len + RS_PARITY_SIZE;
    if (total_len > RS_BLOCK_SIZE) {
        return -1;
    }

    // Compute syndromes
    uint8_t syndromes[RS_PARITY_SIZE];
    compute_syndromes(data, total_len, syndromes);

    // Check if all syndromes are zero (no errors)
    int has_errors = 0;
    for (int i = 0; i < RS_PARITY_SIZE; i++) {
        if (syndromes[i] != 0) {
            has_errors = 1;
            break;
        }
    }

    if (!has_errors) {
        return 0;  // No errors
    }

    // Find error locator polynomial using Berlekamp-Massey
    uint8_t sigma[RS_PARITY_SIZE + 1];
    int sigma_deg;
    int num_errors_expected = berlekamp_massey(syndromes, sigma, &sigma_deg);

    if (num_errors_expected > RS_MAX_ERRORS) {
        return -1;  // Too many errors
    }

    // Find error positions using Chien search
    uint8_t positions[RS_MAX_ERRORS];
    int num_errors;
    if (chien_search(sigma, sigma_deg, total_len, positions, &num_errors) != 0) {
        return -1;  // Inconsistent error count
    }

    // Compute error values using Forney algorithm
    uint8_t error_values[RS_MAX_ERRORS];
    forney(syndromes, sigma, sigma_deg, positions, num_errors, total_len, error_values);

    // Apply corrections
    for (int i = 0; i < num_errors; i++) {
        if (positions[i] < total_len) {
            data[positions[i]] ^= error_values[i];
        }
    }

    return num_errors;
}

// =============================================================================
// Block-level operations
// =============================================================================

size_t rs_encode_blocks(const uint8_t *data, size_t data_len, uint8_t *output) {
    if (!rs_initialized) rs_init();

    size_t output_len = 0;
    size_t remaining = data_len;
    const uint8_t *src = data;
    uint8_t *dst = output;

    while (remaining > 0) {
        size_t block_data = (remaining > RS_DATA_SIZE) ? RS_DATA_SIZE : remaining;
        size_t encoded_len = rs_encode(src, block_data, dst);

        // Pad to full block size for consistent block boundaries
        if (encoded_len < RS_BLOCK_SIZE) {
            memset(dst + encoded_len, 0, RS_BLOCK_SIZE - encoded_len);
        }

        src += block_data;
        dst += RS_BLOCK_SIZE;
        output_len += RS_BLOCK_SIZE;
        remaining -= block_data;
    }

    return output_len;
}

int rs_decode_blocks(uint8_t *data, size_t total_len, uint8_t *output, size_t output_len) {
    if (!rs_initialized) rs_init();

    int total_errors = 0;
    size_t remaining_output = output_len;
    uint8_t *src = data;
    uint8_t *dst = output;

    while (total_len >= RS_BLOCK_SIZE && remaining_output > 0) {
        // Always decode with full RS_DATA_SIZE since encoder pads to full blocks
        // But only copy the bytes we actually need
        size_t bytes_to_copy = (remaining_output > RS_DATA_SIZE) ? RS_DATA_SIZE : remaining_output;

        // Decode block with full data size (modifies src in place)
        int errors = rs_decode(src, RS_DATA_SIZE);
        if (errors < 0) {
            return -1;  // Uncorrectable block
        }
        total_errors += errors;

        // Copy only the bytes we need to output
        memcpy(dst, src, bytes_to_copy);

        src += RS_BLOCK_SIZE;
        dst += bytes_to_copy;
        total_len -= RS_BLOCK_SIZE;
        remaining_output -= bytes_to_copy;
    }

    return total_errors;
}
