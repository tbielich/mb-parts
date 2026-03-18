export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ static: '/' });
  eleventyConfig.addPassthroughCopy({ 'site/assets': 'assets' });

  return {
    dir: {
      input: 'site',
      includes: '_includes',
      data: '_data',
      output: 'dist',
    },
    htmlTemplateEngine: 'njk',
    markdownTemplateEngine: 'njk',
    templateFormats: ['njk', 'md', 'html'],
  };
}
