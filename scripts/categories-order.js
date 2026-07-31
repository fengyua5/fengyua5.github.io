const FIRST_CATEGORIES = ['AI'];

hexo.extend.helper.register('flatpaper_sorted_categories', function () {
  const categories = this.site.categories ? this.site.categories.toArray() : [];
  const first = categories.filter((c) => FIRST_CATEGORIES.includes(c.name));
  const rest = categories.filter((c) => !FIRST_CATEGORIES.includes(c.name));
  return first.concat(rest);
});
