# TVDOS Synopses Format (TSF) Version 1.0 Draft

## 1. Scope

The TVDOS Synopses Format (TSF) is a machine-readable command interface description language.

A TSF document describes:

* Command grammar
* Options and flags
* Positional arguments
* Subcommands
* Argument types
* Completion sources
* Validation constraints

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) when, and only when, they appear in all capitals. Lowercase uses of these words carry their ordinary English meaning and impose no normative requirement.

TSF MUST be valid JSON. A TSF document MUST be encoded such that its byte stream contains only ASCII characters: any character outside the ASCII range (U+0000–U+007F) MUST be represented using a JSON `\uXXXX` escape sequence rather than emitted as a literal multibyte character. Consumers MUST decode such escapes per the JSON specification.

---

# 2. Design Goals

TSF SHALL:

* Be machine-readable.
* Be human-authorable.
* Support automatic shell completion.
* Support automatic help generation.
* Support parser generation.
* Support GUI generation.

The structured synopsis grammar SHALL be the sole normative description of command syntax; every other representation, including human-readable usage strings, is treated as generated output derived from it. This principle is referenced rather than restated elsewhere in this document.

---

# 3. Root Object

A TSF document SHALL contain one JSON object.

Example:

```json
{
  "tsfVersion": "1.0",
  "name": "cp",
  "summary": "Copy files and directories",
  "symbols": {},
  "synopsis": {}
}
```

---

# 4. Root Fields

| Field       | Required | Type   | Notes                                                        |
| ----------- | -------- | ------ | ------------------------------------------------------------ |
| tsfVersion  | yes      | string | Version of TSF this document targets.                        |
| name        | yes      | string | Command name as invoked.                                     |
| summary     | yes      | string | One-line description.                                        |
| symbols     | yes      | object | The symbol table (§5).                                       |
| synopsis    | yes      | object | The synopsis grammar root node (§12).                        |
| description | no       | string | Free-form long description for help generation.              |
| constraints | no       | array  | Constraint objects (§18).                                    |
| metadata    | no       | object | Free-form, non-normative data reserved for authors and hosts (§20). |

---

# 5. Symbol Table

All command elements SHALL be declared in the symbol table. The synopsis grammar SHALL reference symbols by identifier.

Example:

```json
{
  "symbols": {
    "recursive": {
      "kind": "option",
      "long": "--recursive",
      "short": "-r"
    },

    "source": {
      "kind": "positional",
      "type": "path"
    }
  }
}
```

---

# 6. Symbol Kinds

Valid symbol kinds:

```text
option
positional
subcommand
group
```

Each kind is defined in §8, §9, §10, and §11 respectively.

---

# 7. Argument Descriptors

An *argument descriptor* describes a single consumed value. The same descriptor shape is used in two places: directly on a `positional` symbol (§9), and as the `value` of an `option` symbol (§8). Defining it once keeps the two consistent.

## 7.1 Argument Descriptor Fields

| Field      | Required | Type           | Notes                                                            |
| ---------- | -------- | -------------- | ---------------------------------------------------------------- |
| type       | no       | string         | One of the built-in types (§15). Defaults to `string`.           |
| name       | no       | string         | Metavar shown in generated usage (e.g. `FILE`, `WHEN`).          |
| values     | cond.    | array          | Permitted values; **REQUIRED** when `type` is `enum`, otherwise **OPTIONAL** (§15).        |
| default    | no       | any            | Default value used for help generation and GUI prefill.          |
| validation | no       | object         | Value-level validation (§7.2).                                   |
| completion | no       | object         | Completion override (§16).                                       |
| summary    | no       | string         | Short description of the value.                                  |

Each entry in `values` SHALL be either a bare JSON value, or an object of the form `{ "value": <value>, "summary": <string> }`. The optional per-value `summary` is used for completion hints and help generation.

## 7.2 Validation Object

`validation` expresses value-level checks that the grammar cannot:

| Field     | Applies to        | Notes                                              |
| --------- | ----------------- | -------------------------------------------------- |
| pattern   | string-like types | A regular expression the value MUST match.         |
| minimum   | numeric types     | Inclusive lower bound.                              |
| maximum   | numeric types     | Inclusive upper bound.                              |
| minLength | string-like types | Minimum length in characters.                      |
| maxLength | string-like types | Maximum length in characters.                      |

`pattern` is a regular expression; the supported flavour is implementation-defined, and authors are **RECOMMENDED** to restrict patterns to a portable subset. Because the document is ASCII-only (§1), any non-ASCII character within a pattern MUST be `\u`-escaped.

---

# 8. Option Symbols

Example:

```json
{
  "recursive": {
    "kind": "option",
    "long": "--recursive",
    "short": "-r",
    "summary": "Copy directories recursively"
  }
}
```

An option carrying an argument declares it via `value`, which is an argument descriptor (§7):

```json
{
  "output": {
    "kind": "option",
    "long": "--output",
    "short": "-o",
    "summary": "Write output to FILE",
    "value": {
      "name": "FILE",
      "type": "file",
      "required": true
    }
  }
}
```

An enumerated option value (the common `--color=WHEN` idiom) makes completion trivial:

```json
{
  "color": {
    "kind": "option",
    "long": "--color",
    "summary": "Colourise output",
    "value": {
      "name": "WHEN",
      "type": "enum",
      "values": [
        { "value": "always", "summary": "Always colourise" },
        { "value": "never",  "summary": "Never colourise" },
        { "value": "auto",   "summary": "Colourise when stdout is a terminal" }
      ],
      "default": "auto",
      "required": false
    }
  }
}
```

## 8.1 Option Fields

| Field     | Required | Type    | Notes                                                                 |
| --------- | -------- | ------- | --------------------------------------------------------------------- |
| kind      | yes      | string  | `option`.                                                             |
| long      | cond.    | string  | Long form, e.g. `--recursive`.                                        |
| short     | cond.    | string  | Short form, e.g. `-r`.                                                |
| summary   | no       | string  | One-line description.                                                 |
| value     | no       | object  | Argument descriptor (§7). Omit for a bare flag.                       |
| negatable | no       | boolean | If `true`, a `--no-<long>` form is also accepted. Defaults to `false`. |

At least one of `long` or `short` SHALL exist.

The `value` object MAY additionally carry a `required` field (default `true`). When `required` is `true`, the option consumes a mandatory argument; when `false`, the argument is optional (as in `--color` with or without `=WHEN`).

How many times an option may appear (for example a repeated `-v`) is expressed in the grammar via `repeat` or `oneOrMore` (§13), not by a field on the symbol; this keeps multiplicity in a single place.

---

# 9. Positional Symbols

A positional symbol is an argument descriptor (§7) plus its `kind`.

Example:

```json
{
  "source": {
    "kind": "positional",
    "type": "path",
    "summary": "Source file"
  }
}
```

## 9.1 Positional Fields

| Field      | Required | Type   | Notes                                       |
| ---------- | -------- | ------ | ------------------------------------------- |
| kind       | yes      | string | `positional`.                               |
| type       | no       | string | Built-in type (§15). Defaults to `string`.  |
| name       | no       | string | Metavar shown in generated usage.           |
| values     | cond.    | array  | **REQUIRED** when `type` is `enum`.             |
| default    | no       | any    | Default value.                              |
| validation | no       | object | Value-level validation (§7.2).              |
| completion | no       | object | Completion override (§16).                  |
| summary    | no       | string | One-line description.                       |

Whether a positional is required or optional is expressed in the grammar (by wrapping it in `optional` or not), not by a field here; this keeps a single source of truth.

---

# 10. Subcommand Symbols

Example:

```json
{
  "clone": {
    "kind": "subcommand",
    "summary": "Clone repository",
    "tsf": "git.clone"
  }
}
```

Subcommands MAY reference:

* embedded TSF documents
* external TSF documents

Implementation-specific resolution of the `tsf` reference is permitted.

---

# 11. Group Symbols

A group collects related symbols, typically options, so that the grammar can refer to them collectively. A group is what backs the conventional `[OPTION...]` slot.

Example:

```json
{
  "commonOptions": {
    "kind": "group",
    "summary": "Common options",
    "members": [
      "recursive",
      "force",
      "verbose"
    ]
  }
}
```

## 11.1 Group Fields

| Field   | Required | Type   | Notes                                            |
| ------- | -------- | ------ | ------------------------------------------------ |
| kind    | yes      | string | `group`.                                         |
| members | yes      | array  | Identifiers of the symbols this group contains.  |
| summary | no       | string | One-line description.                            |

A `reference` to a group (§13) is equivalent to a `choice` over its members. Wrapping that reference in `repeat` yields the familiar "any number of these options, in any order" behaviour of `[OPTION...]`.

---

# 12. Synopsis Grammar

The synopsis object SHALL describe valid command invocations.

Every node SHALL contain:

```json
{
  "type": "<node-type>"
}
```

---

# 13. Grammar Node Types

## sequence

All children must appear in order.

```json
{
  "type": "sequence",
  "children": []
}
```

Equivalent:

```text
A B C
```

---

## choice

Exactly one child must appear.

```json
{
  "type": "choice",
  "children": []
}
```

Equivalent:

```text
(A | B | C)
```

---

## optional

Child may appear zero or one time.

```json
{
  "type": "optional",
  "child": {}
}
```

Equivalent:

```text
[A]
```

---

## repeat

Child may appear zero or more times.

```json
{
  "type": "repeat",
  "child": {}
}
```

Equivalent:

```text
A...
```

---

## oneOrMore

Child must appear at least once. This node is sugar for `sequence[A, repeat[A]]` and carries no semantics beyond that combination; it exists for authoring convenience.

```json
{
  "type": "oneOrMore",
  "child": {}
}
```

Equivalent:

```text
A [A...]
```

---

## reference

References a symbol. When the referenced symbol is a group, the reference expands to a `choice` over the group's members (§11).

```json
{
  "type": "reference",
  "symbol": "recursive"
}
```

---

# 14. Example Synopsis

Human form:

```text
cp [OPTION...] SOURCE DEST
```

Symbol table (abbreviated):

```json
{
  "symbols": {
    "recursive":   { "kind": "option", "long": "--recursive", "short": "-r" },
    "force":       { "kind": "option", "long": "--force", "short": "-f" },
    "options":     { "kind": "group", "members": ["recursive", "force"] },
    "source":      { "kind": "positional", "type": "path", "name": "SOURCE" },
    "destination": { "kind": "positional", "type": "path", "name": "DEST" }
  }
}
```

Synopsis:

```json
{
  "synopsis": {
    "type": "sequence",
    "children": [
      {
        "type": "repeat",
        "child": {
          "type": "reference",
          "symbol": "options"
        }
      },
      {
        "type": "reference",
        "symbol": "source"
      },
      {
        "type": "reference",
        "symbol": "destination"
      }
    ]
  }
}
```

The `options` group is a declared symbol, so the `[OPTION...]` slot now satisfies the rule in §5 that every referenced element exists in the symbol table.

---

# 15. Argument Types

Built-in primitive types:

```text
string
integer
float
boolean
path
file
directory
url
hostname
user
group
command
enum
```

`enum` restricts a value to one of an explicit set; a descriptor whose `type` is `enum` SHALL provide a `values` array (§7.1). The `values` array MAY also be supplied for non-`enum` types as a soft suggestion list, in which case it informs completion but does not restrict valid input.

Unknown types SHALL be interpreted as `string`. Implementations are **RECOMMENDED** to emit a diagnostic when they do so, since an unknown type is usually an authoring error rather than an intentional fallback.

Each type carries a default completion behaviour (§16): for example `path`, `file`, and `directory` complete against the filesystem, `user` and `group` against the host's account databases, and `enum` against its `values`. A `completion` block overrides this default.

---

# 16. Completion

If a descriptor has no `completion` block, completion is derived automatically from its `type` (and from `values` when the type is `enum`). A `completion` block overrides that default.

| method   | Notes                                                                       |
| -------- | --------------------------------------------------------------------------- |
| type     | Use the default completion implied by the descriptor's `type`. (Implicit when no block is present.) |
| enum     | Complete from the descriptor's `values`. (Implicit when `type` is `enum`.)  |
| internal | Use a named provider resolved by the host.                                  |
| command  | Run a command whose output supplies the candidates.                         |
| list     | Offer a static inline list of suggestions, without restricting input.       |
| none     | Suppress completion for this value.                                         |

Example using a named internal provider:

```json
{
  "branch": {
    "kind": "positional",
    "type": "string",

    "completion": {
      "method": "internal",
      "provider": "branches"
    }
  }
}
```

---

# 17. Constraints

Constraints describe relationships not expressible in the grammar. They are listed in the root `constraints` array (§4).

Three of the four constraint types below (`conflicts`, `requires`, `cardinality`) are validation predicates: they describe whether an invocation is well-formed. The fourth, `implies`, is a derivation: it sets a value as a side effect rather than rejecting input. Consumers should treat it accordingly.

Field naming is uniform: symmetric constraints use `symbols`; asymmetric constraints use `subject` and `targets`.

---

## conflicts

Symmetric. The listed symbols are mutually exclusive.

```json
{
  "type": "conflicts",
  "symbols": [
    "stdout",
    "output"
  ]
}
```

Meaning:

```text
--stdout conflicts with --output
```

---

## requires

Asymmetric. If `subject` is present, every symbol in `targets` MUST also be present.

```json
{
  "type": "requires",
  "subject": "output",
  "targets": [
    "format"
  ]
}
```

---

## implies

Asymmetric derivation. If `subject` is present, every symbol in `targets` is implicitly set.

```json
{
  "type": "implies",
  "subject": "verbose",
  "targets": [
    "log"
  ]
}
```

---

## cardinality

Symmetric. Constrains how many of the listed symbols may appear.

```json
{
  "type": "cardinality",
  "symbols": [
    "create",
    "extract",
    "list"
  ],
  "minimum": 1,
  "maximum": 1
}
```

Equivalent:

```text
exactly one of:
create
extract
list
```

---

# 18. Generated Usage

Implementations SHOULD generate usage text from the synopsis grammar. Per §2, that text is non-authoritative output; the grammar remains the sole normative description.

---

# 19. Extensibility and Compatibility

TSF distinguishes between additive content, which may be ignored safely, and structural content, which may not.

* **Unknown fields** on otherwise-valid objects SHALL be ignored. Future minor versions MAY add fields without invalidating existing documents or consumers.
* **Unknown grammar node types (§13) and unknown symbol kinds (§6)** SHALL cause the document to be rejected, or to enter an explicitly defined degraded mode. They cannot be ignored, because doing so would silently change the set of accepted invocations.

Authors and hosts that need to attach implementation-specific data SHOULD do so either inside the root `metadata` object or under field names prefixed with `x-`. Names without that prefix are reserved for future versions of this specification.

Future TSF versions MAY introduce additional grammar node types, symbol kinds, types, and constraint types. Consumers SHOULD report the highest `tsfVersion` they support so that producers can downgrade gracefully.
