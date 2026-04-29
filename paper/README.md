# ASO paper (LaTeX)

Build from this directory (requires a LaTeX distribution with `pdflatex`):

```bash
cd paper && pdflatex -interaction=nonstopmode aso_main.tex && pdflatex -interaction=nonstopmode aso_main.tex
```

To refresh the copy linked from the repo root README, copy the PDF to `docs/`:

```bash
cp aso_main.pdf ../docs/aso_main.pdf
```
