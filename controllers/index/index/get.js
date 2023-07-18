module.exports = (req, res) => {
  return res.render('index/index', {
    page: 'index/index',
    title: 'Dashboard',
    includes: {
      external: {
        css: ['confirm', 'form', 'formPopUp', 'general', 'header', 'items', 'navbar', 'navigation', 'text'],
        js: ['createConfirm', 'createFormPopUp', 'navbarListeners', 'page', 'serverRequest']
      }
    }
  });
}
