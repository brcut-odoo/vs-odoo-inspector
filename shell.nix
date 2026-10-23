# Node and pnpm for building this extension, e.g. from VS Code tasks:
#   nix-shell --run "pnpm run build"
{ pkgs ? import <nixpkgs> { } }:
pkgs.mkShell {
  packages = with pkgs; [ 
    nodejs_24 
    pnpm 
  ];
}
