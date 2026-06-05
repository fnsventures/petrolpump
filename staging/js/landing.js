const SLIDESHOW_IMAGES = [
  "assets/landing-01.JPG",
  "assets/landing-02.JPG",
  "assets/landing-03.JPG",
  "assets/landing-04.JPG",
];

/** Used when slideshow photos are not deployed (e.g. local dev without image assets). */
const SLIDESHOW_FALLBACK = "assets/bpcl-logo.png";

const SLIDE_INTERVAL_MS = 2500;
const SLIDE_FADE_MS = 800;

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function probeImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(src);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function resolveSlideshowImages() {
  const loaded = await Promise.all(SLIDESHOW_IMAGES.map((src) => probeImage(src)));
  const available = loaded.filter(Boolean);
  return available.length > 0 ? available : [SLIDESHOW_FALLBACK];
}

function startRandomSlideshow(imageList) {
  const slides = [
    document.querySelector(".slideshow .slide-a"),
    document.querySelector(".slideshow .slide-b"),
  ];
  if (slides.some((el) => !el) || !imageList.length) return;

  let order = shuffle(imageList);
  let index = 0;
  let active = 0;

  const showSlide = () => {
    const next = order[index];
    const nextSlide = slides[1 - active];
    const currentSlide = slides[active];

    nextSlide.style.backgroundImage = `url("${next}")`;
    nextSlide.classList.add("is-visible");

    window.setTimeout(() => {
      currentSlide.classList.remove("is-visible");
    }, SLIDE_FADE_MS);

    active = 1 - active;
    index += 1;

    if (index >= order.length) {
      order = shuffle(imageList);
      index = 0;
    }
  };

  slides[active].style.backgroundImage = `url("${order[0]}")`;
  slides[active].classList.add("is-visible");
  index = 1;

  window.setInterval(showSlide, SLIDE_INTERVAL_MS);
}

function initAboutPopupA11y() {
  const panel = document.getElementById("about-popup");
  if (!panel) return;
  const sync = () => {
    const open = location.hash === "#about-popup";
    panel.setAttribute("aria-hidden", open ? "false" : "true");
  };
  sync();
  window.addEventListener("hashchange", sync);
}

document.addEventListener("DOMContentLoaded", async () => {
  const images = await resolveSlideshowImages();
  startRandomSlideshow(images);
  initAboutPopupA11y();
});
