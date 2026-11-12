import { useEffect, useRef } from "react";

export type PromptImage = {
  id: string;
  src: string;
  title: string;
};

type Props = {
  value: string;
  placeholder: string;
  disabled: boolean;
  images: PromptImage[];
  onChange: (value: string) => void;
  onGenerate: () => void;
};

function createChip(image: PromptImage, editor: HTMLDivElement, notify: () => void, disabled: boolean) {
  const chip = document.createElement("span");
  chip.className = "attempt-prompt-image";
  chip.contentEditable = "false";
  chip.dataset.imageId = image.id;
  chip.title = image.title;

  const img = document.createElement("img");
  img.src = image.src;
  img.draggable = false;
  chip.appendChild(img);
  if (disabled) return chip;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.tabIndex = -1;
  remove.textContent = "×";
  remove.setAttribute("aria-label", "移除图片");
  remove.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  remove.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    chip.remove();
    notify();
    editor.focus();
  });
  chip.appendChild(remove);
  return chip;
}

function renderPrompt(editor: HTMLDivElement, value: string, images: PromptImage[], notify: () => void, disabled: boolean) {
  editor.innerHTML = "";
  const parts = value.split(/(\[\[image:[^\]]+\]\])/g);
  for (const part of parts) {
    const match = /^\[\[image:(.+)\]\]$/.exec(part);
    if (match) {
      const image = images.find((item) => item.id === match[1]);
      if (image) editor.appendChild(createChip(image, editor, notify, disabled));
      continue;
    }
    if (!part) continue;
    const lines = part.split("\n");
    lines.forEach((line, index) => {
      if (index > 0) editor.appendChild(document.createElement("br"));
      if (line) editor.appendChild(document.createTextNode(line));
    });
  }
}

function serializePrompt(editor: HTMLDivElement): string {
  let output = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      output += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element.dataset.imageId) {
      output += `[[image:${element.dataset.imageId}]]`;
      return;
    }
    if (element.tagName === "BR") {
      output += "\n";
      return;
    }
    if (element.tagName === "DIV" || element.tagName === "P") {
      if (output && !output.endsWith("\n")) output += "\n";
      element.childNodes.forEach(walk);
      return;
    }
    element.childNodes.forEach(walk);
  };
  editor.childNodes.forEach(walk);
  return output.replace(/\u00a0/g, " ").replace(/\n+$/, "");
}

export function PromptEditor({ value, placeholder, disabled, images, onChange, onGenerate }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (serializePrompt(editor) === value) return;
    renderPrompt(editor, value, images, () => onChangeRef.current(serializePrompt(editor)), disabled);
  }, [value, images, disabled]);

  function insertImage(id: string) {
    const editor = editorRef.current;
    if (!editor || disabled) return;
    const image = imagesRef.current.find((item) => item.id === id);
    if (!image) return;
    if (Array.from(editor.querySelectorAll("[data-image-id]")).some((chip) => (chip as HTMLElement).dataset.imageId === id)) {
      editor.focus();
      return;
    }
    editor.focus();
    const selection = window.getSelection();
    let range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range || !editor.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    range.deleteContents();
    const chip = createChip(image, editor, () => onChangeRef.current(serializePrompt(editor)), false);
    range.insertNode(chip);
    const space = document.createTextNode("\u00a0");
    chip.after(space);
    range.setStartAfter(space);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    onChangeRef.current(serializePrompt(editor));
  }

  return (
    <div
      ref={editorRef}
      className="attempt-prompt-editor"
      contentEditable={!disabled}
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onInput={() => {
        const editor = editorRef.current;
        if (editor) onChangeRef.current(serializePrompt(editor));
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          onGenerate();
        }
      }}
      onPaste={(event) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        if (text) document.execCommand("insertText", false, text);
      }}
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (disabled) return;
        event.preventDefault();
        const id = event.dataTransfer.getData("application/x-opencanvas-image") || event.dataTransfer.getData("text/plain");
        if (id) insertImage(id);
      }}
    />
  );
}
