// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';

(async function init() {
  const { context, actions } = await DA_SDK;

  const button = document.createElement('button');
  button.textContent = 'Insert page path';

  button.addEventListener('click', () => {
    actions.sendText(context.path);
  });

  document.body.append(button);
}());
