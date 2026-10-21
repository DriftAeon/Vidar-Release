# Render fixture

Ordered list with a start value, tight then loose, nested:

3. three
4. four
   - tight nested
   - another

5. five (loose)

   with a second paragraph

| left | center | right |
|:-----|:------:|------:|
| a    |   b    |     c |

Formatted image label: ![a **bold** label](http://127.0.0.1:1447/should-not-fetch.png)

~~strike~~, entities: &amp; &lt;script&gt;alert(1)&lt;/script&gt;, autolink <http://example.com/auto>, link [text](http://example.com/link "t").

Raw HTML in source: <script>alert(1)</script> <img src="http://127.0.0.1:1447/raw-img">

```ts
const x = "fenced";
```

> quote with `code` and *em* and **strong**

---

Final paragraph.
