class Navigation extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <nav class="main">
        <a class="entrance route" href="/home"><span>Entrance [Home]</span></a>
        <a class="about route" href="/about"><span>Office [Me]</span></a>
        <a class="atelier route" href="/atelier"><span>Atelier [Art]</span></a>
        <a class="reads route" href="/reads"><span>Reads [Blog]</span></a>
        <a class="radio route" href="/radio"><span>Radio [Guestbook]</span></a>
        <a class="pets route" href="/pets"><span>Fauna [Pets]</span></a>
        <a class="storage route" href="/storage"><span>Storage [Resources]</span></a>
        <a class="contact route" href="/contacts"><span>Cafeteria [Contacts]</span></a>
      </nav>
      <div id="statuscafe"><div id="statuscafe-username"></div><div id="statuscafe-content"></div></div><script src="https://status.cafe/current-status.js?name=lyonid" defer></script>
      
        `
  }
}


customElements.define('main-nav', Navigation);