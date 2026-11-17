// Same look as Next's built-in 404 page.
export function NotFound() {
  return (
    <div className="flex h-screen flex-col items-center justify-center text-center">
      <div>
        <h1 className="mr-5 inline-block border-r border-foreground/30 pr-[23px] align-top text-2xl leading-[49px] font-medium">404</h1>
        <div className="inline-block">
          <h2 className="m-0 text-sm leading-[49px] font-normal">This page could not be found.</h2>
        </div>
      </div>
    </div>
  );
}
