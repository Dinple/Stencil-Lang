# Sphinx configuration for the Stencil documentation.
#   pip install -r docs/requirements.txt
#   sphinx-build -b html docs _site
import os
import shutil

from pygments.lexer import RegexLexer, bygroups, words
from pygments.token import Comment, Keyword, Name, Number, Operator, Punctuation, String, Text

project = 'Stencil'
author = 'Yucheng Wang'
copyright = '2026, Yucheng Wang'
release = '0.2'

extensions = ['myst_parser', 'sphinx_copybutton']
myst_enable_extensions = ['colon_fence', 'deflist']
myst_heading_anchors = 3
source_suffix = {'.md': 'markdown'}
exclude_patterns = ['_build']
templates_path = ['_templates']
smartquotes = False          # keep quotes, dashes and dots as typed
suppress_warnings = ['myst.xref_missing']

html_theme = 'sphinx_book_theme'
html_title = 'Stencil'
html_static_path = ['_static']
html_favicon = '_static/stencil-symbol.svg'
html_css_files = ['stencil.css']
html_theme_options = {
    'repository_url': 'https://github.com/Dinple/Stencil-Lang',
    'repository_branch': 'yw-dev',
    'path_to_docs': 'docs',
    'use_repository_button': True,
    'use_issues_button': True,
    'use_edit_page_button': False,
    'use_download_button': True,
    'show_navbar_depth': 2,
    'show_toc_level': 2,
    'logo': {
        'image_light': '_static/stencil-horizontal.svg',
        'image_dark': '_static/stencil-horizontal-dark.svg',
        'alt_text': 'Stencil',
    },
}

# The language, vocabulary and API documents live in doc/ at the top of the
# repository; copy them in so they render as part of this site.
HERE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(HERE, 'reference'), exist_ok=True)
for name in ('SPEC.md', 'VOCABULARY.md', 'API.md'):
    shutil.copyfile(os.path.join(HERE, '..', 'doc', name), os.path.join(HERE, 'reference', name))


class StencilLexer(RegexLexer):
    """Highlighting for .stencil files."""
    name = 'Stencil'
    aliases = ['stencil']
    filenames = ['*.stencil']
    tokens = {
        'root': [
            (r'\s+', Text),
            (r'#.*$', Comment.Single),
            (r'"(\\\\|\\"|[^"])*"', String),
            (r'^(stencil)(\s+)([0-9.]+)', bygroups(Keyword.Namespace, Text, Number)),
            (words(('import', 'as', 'module', 'technology', 'drop', 'base', 'required'), suffix=r'\b'), Keyword),
            (words(('true', 'false', 'none', 'all', 'fill'), suffix=r'\b'), Keyword.Constant),
            (r'&[A-Za-z_][\w.]*', Name.Decorator),
            (r'[0-9]+(\.[0-9]+)?(nm|um|mm)?\b', Number),
            (r'[A-Za-z_]\w*(?=\s*\{)', Name.Class),
            (r'[A-Za-z_]\w*(?=\s*=)', Name.Attribute),
            (r'[A-Za-z_][\w.]*', Name),
            (r'\.\.|==|!=|>=|<=|[-+*/<>=]', Operator),
            (r'[{}\[\]();,]', Punctuation),
        ],
    }


def setup(app):
    app.add_lexer('stencil', StencilLexer)
