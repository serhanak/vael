# vael sample document

A single document that exercises every renderer feature (Markdown, GFM, Prism,
KaTeX). Open it in **Split** mode to check the preview, and use it as the source
for the **Export HTML…** test.

## Emphasis and inline

Some **bold**, some *italic*, some `inline code`, and a [link to example.com](https://example.com).
A bare URL should linkify: https://vael.example .

## Lists and tasks

- plain item
- nested
  - child a
  - child b

1. first
2. second

- [x] a completed task
- [ ] an open task

## Table (GFM)

| Feature   | Status | Notes            |
|-----------|:------:|------------------|
| Encoding  |   ✅   | name↔byte split  |
| Preview   |   ✅   | single engine    |
| Export    |   ◑    | HTML done        |

## Blockquote

> The single canonical renderer means preview and export cannot drift.
> — the plan

## Code (Prism syntax highlight)

```js
// JavaScript
function greet(name) {
  const msg = `hello, ${name}`
  return msg.toUpperCase()
}
```

```python
# Python
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

```rust
// Rust
fn main() {
    let xs: Vec<i32> = (1..=5).map(|x| x * x).collect();
    println!("{:?}", xs);
}
```

```sql
SELECT id, name FROM users WHERE active = true ORDER BY name;
```

## Math (KaTeX → MathML)

Inline math renders in a sentence: the mass–energy relation is $E = mc^2$, and
$\sqrt{a^2 + b^2}$ is the hypotenuse.

Display math is centered on its own line:

$$\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}$$

$$\frac{\partial}{\partial t}\,\Psi = \hat{H}\,\Psi$$

A matrix:

$$\begin{bmatrix} 1 & 0 \\ 0 & 1 \end{bmatrix}$$

## Footnotes

Here is a statement with a footnote.[^1] And another.[^long]

[^1]: The short footnote.
[^long]: A longer footnote with a [link](https://example.com) inside it.

## Image (remote — for the export offline-limitation check)

The image below is referenced by a remote URL. In the live preview it may load;
in an **exported** .html opened offline it will NOT load (documented limitation —
image inlining is a later pass). This is expected, not a bug.

![remote badge](https://example.com/badge.png)

## Turkish text (encoding check)

Türkçe karakterler: ş ğ İ ı ö ü ç Ş Ğ Ö Ü Ç — bunlar Windows-1254'te vardır.

---

End of sample.
