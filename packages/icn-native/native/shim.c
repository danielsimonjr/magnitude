// icn shim: pointer/scalar-only wrappers around the parts of the llama.cpp C
// API that take or return structs by value (llama_model_params,
// llama_context_params, llama_batch, llama_sampler_chain_params,
// llama_chat_message arrays). bun:ffi cannot pass structs by value, so these
// wrappers build the structs on the C side from scalar arguments.
//
// Everything that already uses only pointers and scalars (tokenize, vocab
// queries, logits, most sampler init helpers, ...) is bound directly against
// libllama from TypeScript.

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ggml-backend.h"
#include "llama.h"

#if defined(_WIN32)
#define ICN_API __declspec(dllexport)
#else
#define ICN_API __attribute__((visibility("default")))
#endif

// ---------------------------------------------------------------------------
// Backend / logging
// ---------------------------------------------------------------------------

ICN_API void icn_backend_init(void) {
    ggml_backend_load_all();
    llama_backend_init();
}

ICN_API void icn_backend_free(void) {
    llama_backend_free();
}

static int g_min_log_level = GGML_LOG_LEVEL_WARN;

static void icn_log_callback(enum ggml_log_level level, const char * text, void * user_data) {
    (void) user_data;
    // CONT (5) continues the previous line; treat it as passing.
    if (level != GGML_LOG_LEVEL_CONT && (int) level < g_min_log_level) {
        return;
    }
    fputs(text, stderr);
}

// Install a stderr logger that drops messages below `min_level`
// (ggml_log_level: 0 none, 1 debug, 2 info, 3 warn, 4 error).
ICN_API void icn_log_set_min_level(int32_t min_level) {
    g_min_log_level = min_level;
    llama_log_set(icn_log_callback, NULL);
}

// ---------------------------------------------------------------------------
// Backend device enumeration
// ---------------------------------------------------------------------------

ICN_API size_t icn_backend_dev_count(void) {
    return ggml_backend_dev_count();
}

ICN_API const char * icn_backend_dev_name(size_t index) {
    if (index >= ggml_backend_dev_count()) {
        return NULL;
    }
    return ggml_backend_dev_name(ggml_backend_dev_get(index));
}

ICN_API const char * icn_backend_dev_description(size_t index) {
    if (index >= ggml_backend_dev_count()) {
        return NULL;
    }
    return ggml_backend_dev_description(ggml_backend_dev_get(index));
}

// Returns ggml_backend_dev_type as int32, or -1 when index is out of range.
ICN_API int32_t icn_backend_dev_type(size_t index) {
    if (index >= ggml_backend_dev_count()) {
        return -1;
    }
    return (int32_t) ggml_backend_dev_type(ggml_backend_dev_get(index));
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

ICN_API struct llama_model * icn_model_load(
        const char * path,
        int32_t      n_gpu_layers,
        int32_t      load_mode,     // enum llama_load_mode: -1 auto, 0 none, 1 mmap, 2 mlock, 3 mmap+mlock, 4 direct io
        bool         vocab_only) {
    struct llama_model_params params = llama_model_default_params();
    params.n_gpu_layers = n_gpu_layers;
    params.load_mode    = (enum llama_load_mode) load_mode;
    params.vocab_only   = vocab_only;
    return llama_model_load_from_file(path, params);
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

ICN_API struct llama_context * icn_context_new(
        struct llama_model * model,
        uint32_t             n_ctx,
        uint32_t             n_batch,
        int32_t              n_threads,
        int32_t              n_threads_batch,
        bool                 embeddings) {
    struct llama_context_params params = llama_context_default_params();
    params.n_ctx      = n_ctx;
    params.n_batch    = n_batch;
    params.n_ubatch   = n_batch < params.n_ubatch ? n_batch : params.n_ubatch;
    params.embeddings = embeddings;
    params.no_perf    = true;
    if (n_threads > 0) {
        params.n_threads = n_threads;
    }
    params.n_threads_batch = n_threads_batch > 0 ? n_threads_batch : params.n_threads;
    return llama_init_from_model(model, params);
}

// Decode `n_tokens` tokens at positions [pos0, pos0 + n_tokens) on sequence
// `seq_id`. When `logits_last_only` is set only the final token requests
// logits (the common autoregressive case); otherwise every token does.
// Returns the llama_decode status (0 = ok, 1 = no KV slot, <0 = error).
ICN_API int32_t icn_decode_tokens(
        struct llama_context * ctx,
        const llama_token    * tokens,
        int32_t                n_tokens,
        llama_pos              pos0,
        llama_seq_id           seq_id,
        bool                   logits_last_only) {
    if (n_tokens <= 0) {
        return -1;
    }
    struct llama_batch batch = llama_batch_init(n_tokens, 0, 1);
    for (int32_t i = 0; i < n_tokens; i++) {
        batch.token   [i] = tokens[i];
        batch.pos     [i] = pos0 + i;
        batch.n_seq_id[i] = 1;
        batch.seq_id  [i][0] = seq_id;
        batch.logits  [i] = logits_last_only ? (i == n_tokens - 1) : 1;
    }
    batch.n_tokens = n_tokens;
    int32_t rc = llama_decode(ctx, batch);
    llama_batch_free(batch);
    return rc;
}

// Convenience wrapper over llama_batch_get_one: positions are inferred by the
// context's memory from the sequence's current length.
ICN_API int32_t icn_decode_simple(
        struct llama_context * ctx,
        llama_token          * tokens,
        int32_t                n_tokens) {
    return llama_decode(ctx, llama_batch_get_one(tokens, n_tokens));
}

ICN_API float * icn_logits(struct llama_context * ctx, int32_t i) {
    return llama_get_logits_ith(ctx, i);
}

ICN_API void icn_memory_clear(struct llama_context * ctx, bool data) {
    llama_memory_clear(llama_get_memory(ctx), data);
}

// Remove positions [p0, p1) of `seq_id` from the context memory (p1 < 0 = to end).
ICN_API bool icn_memory_seq_rm(struct llama_context * ctx, llama_seq_id seq_id, llama_pos p0, llama_pos p1) {
    return llama_memory_seq_rm(llama_get_memory(ctx), seq_id, p0, p1);
}

// Argmax over the vocabulary of the logits for output row `i`. Done in C so
// the hot loop does not copy n_vocab floats into JS per token.
ICN_API int32_t icn_sample_greedy(struct llama_context * ctx, int32_t i, int32_t n_vocab) {
    const float * logits = llama_get_logits_ith(ctx, i);
    if (logits == NULL || n_vocab <= 0) {
        return -1;
    }
    int32_t best = 0;
    float best_v = logits[0];
    for (int32_t t = 1; t < n_vocab; t++) {
        if (logits[t] > best_v) {
            best_v = logits[t];
            best = t;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Sampler chain (struct-by-value params)
// ---------------------------------------------------------------------------

ICN_API struct llama_sampler * icn_sampler_chain_init(bool no_perf) {
    struct llama_sampler_chain_params params = llama_sampler_chain_default_params();
    params.no_perf = no_perf;
    return llama_sampler_chain_init(params);
}

// Build a common temp / top-k / top-p / penalties / dist-or-greedy chain.
// Returns NULL on allocation failure. Ownership of the returned sampler is
// transferred to the caller (free with llama_sampler_free).
ICN_API struct llama_sampler * icn_sampler_chain_build(
        int32_t  n_vocab,
        int32_t  top_k,
        float    top_p,
        float    temperature,
        int32_t  penalty_last_n,
        float    penalty_repeat,
        float    penalty_freq,
        float    penalty_present,
        uint32_t seed) {
    struct llama_sampler * chain = icn_sampler_chain_init(true);
    if (chain == NULL) {
        return NULL;
    }

    if (penalty_last_n != 0 ||
            penalty_repeat != 1.0f ||
            penalty_freq != 0.0f ||
            penalty_present != 0.0f) {
        llama_sampler_chain_add(
            chain,
            llama_sampler_init_penalties(
                n_vocab, penalty_last_n, penalty_repeat, penalty_freq, penalty_present));
    }
    if (top_k > 0) {
        llama_sampler_chain_add(chain, llama_sampler_init_top_k(top_k));
    }
    if (top_p < 1.0f) {
        llama_sampler_chain_add(chain, llama_sampler_init_top_p(top_p, 1));
    }
    if (temperature > 0.0f) {
        llama_sampler_chain_add(chain, llama_sampler_init_temp(temperature));
        llama_sampler_chain_add(chain, llama_sampler_init_dist(seed));
    } else {
        llama_sampler_chain_add(chain, llama_sampler_init_greedy());
    }
    return chain;
}

// ---------------------------------------------------------------------------
// Chat templates (llama_chat_message is a struct)
// ---------------------------------------------------------------------------

// Apply a built-in or named chat template to parallel role/content C-string
// arrays. When `tmpl` is NULL, llama.cpp defaults to "chatml".
// Returns the number of bytes written (or required), or <0 on error.
ICN_API int32_t icn_chat_apply_template(
        const char * tmpl,
        const char ** roles,
        const char ** contents,
        size_t        n_msg,
        bool          add_ass,
        char *        buf,
        int32_t       length) {
    if (n_msg > 0 && (roles == NULL || contents == NULL)) {
        return -1;
    }
    struct llama_chat_message * chat = NULL;
    if (n_msg > 0) {
        chat = (struct llama_chat_message *) calloc(n_msg, sizeof(*chat));
        if (chat == NULL) {
            return -1;
        }
        for (size_t i = 0; i < n_msg; i++) {
            chat[i].role    = roles[i]    != NULL ? roles[i]    : "";
            chat[i].content = contents[i] != NULL ? contents[i] : "";
        }
    }
    int32_t rc = llama_chat_apply_template(tmpl, chat, n_msg, add_ass, buf, length);
    free(chat);
    return rc;
}

ICN_API uint32_t icn_shim_abi_version(void) {
    return 2;
}
