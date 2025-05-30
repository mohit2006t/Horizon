const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const sharingLinkContainer = document.getElementById('sharingLinkContainer');

fileInput.addEventListener('change', (event) => {
  const file = event.target.files[0];

  if (file) {
    fileInfo.innerHTML = `
      <p>Name: ${file.name}</p>
      <p>Size: ${file.size} bytes</p>
    `;

    // Generate placeholder unique link
    const uniqueLink = window.location.href + '#' + Date.now().toString(36) + Math.random().toString(36).substr(2);

    // Create and display the link input field
    const linkInput = document.createElement('input');
    linkInput.type = 'text';
    linkInput.value = uniqueLink;
    linkInput.readOnly = true;

    sharingLinkContainer.innerHTML = ''; // Clear previous link
    sharingLinkContainer.appendChild(linkInput);
    sharingLinkContainer.style.display = 'block';

  } else {
    fileInfo.innerHTML = '';
    sharingLinkContainer.innerHTML = '';
    sharingLinkContainer.style.display = 'none';
  }
});
