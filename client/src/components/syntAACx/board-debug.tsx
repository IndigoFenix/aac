// src/components/syntAACx/board-debug.tsx
import { useBoardStore } from "@/store/board-store";
import { Button } from "@/components/ui/button";

export function BoardDebug() {
  const {
    board,
    boards,
    activeBoardId,
    homeBoardId,
    bookmarkPageId,
    navHistory,
    currentPageId,
    selectBoardById,
    jumpHome,
    jumpBack,
    bookmarkCurrentPage,
    applyButtonAction,
  } = useBoardStore();

  if (!boards.length && !board) {
    return (
      <div className="p-4 bg-gray-100 text-sm">
        No board loaded
      </div>
    );
  }

  const active =
    boards.find((b: any) => b._id === activeBoardId) ||
    (board as any) ||
    boards[0];

  const homeBoard = boards.find((b: any) => b._id === homeBoardId) || null;

  const activePages = active?.pages || [];
  const currentPage =
    activePages.find((p: any) => p.id === currentPageId) || null;
  const bookmarkPage =
    activePages.find((p: any) => p.id === bookmarkPageId) || null;

  const historyLabel =
    navHistory.length && active
      ? navHistory
          .map((id: string) => {
            const page = active.pages.find((p: any) => p.id === id);
            return page?.name || "unknown page";
          })
          .join(" → ")
      : "empty";

  return (
    <div className="p-4 bg-gray-100 text-sm font-mono overflow-auto max-h-96 space-y-3">
      <div>
        <h4 className="font-bold mb-1">Workspace Debug</h4>
        <div>
          <strong>Total boards:</strong>{" "}
          {boards.length || (board ? 1 : 0)}
        </div>
        <div>
          <strong>Active board:</strong> {active?.name || "—"}
        </div>
        <div>
          <strong>Home board:</strong> {homeBoard?.name || "—"}
        </div>
        <div>
          <strong>Current page:</strong> {currentPage?.name || "—"}
        </div>
        <div>
          <strong>Page bookmark:</strong> {bookmarkPage?.name || "—"}
        </div>
        <div>
          <strong>History (pages):</strong> {historyLabel}
        </div>

        <div className="flex flex-wrap gap-2 mt-2">
          <Button
            size="sm"
            variant="outline"
            onClick={jumpHome}
            disabled={!active?.pages?.length}
          >
            Jump home
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={jumpBack}
            disabled={!navHistory.length && !bookmarkPageId}
          >
            Jump back
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={bookmarkCurrentPage}
            disabled={!currentPage}
          >
            Bookmark current page
          </Button>
        </div>
      </div>

      <div>
        <div className="font-semibold mb-1">Boards:</div>
        <div className="flex flex-wrap gap-1">
          {boards.map((b: any) => (
            <Button
              key={b._id}
              size="sm"
              variant={b._id === active?._id ? "default" : "ghost"}
              onClick={() => selectBoardById(b._id)}
            >
              {b.name}
              {b.isHome && <span className="ml-1">🏠</span>}
            </Button>
          ))}
          {!boards.length && board && (
            <span className="text-sm text-slate-500">
              (Single board mode)
            </span>
          )}
        </div>
      </div>

      {active && (
        <div>
          <h4 className="font-bold mb-1">Active Board Debug: {active.name}</h4>
          <div>
            <strong>Grid:</strong> {active.grid.rows}x{active.grid.cols}
          </div>
          <div>
            <strong>Pages:</strong> {active.pages.length}
          </div>

          {active.pages.map((page: any, pageIdx: number) => (
            <div
              key={page.id}
              className="mt-3 border-l-2 border-blue-300 pl-2"
            >
              <div>
                <strong>
                  Page {pageIdx + 1}
                  {page.id === active.pages[0]?.id ? " (home)" : ""}
                  :
                </strong>{" "}
                {page.name}
              </div>
              <div>
                <strong>Buttons:</strong> {page.buttons.length}
              </div>

              {page.buttons.map((button: any, btnIdx: number) => (
                <div
                  key={button.id}
                  className="mt-2 ml-4 p-2 bg-white rounded text-sm"
                >
                  <div>
                    <strong>Button {btnIdx + 1}:</strong> "{button.label}"
                  </div>
                  <div>
                    <strong>Position:</strong> Row {button.row}, Col{" "}
                    {button.col}
                  </div>
                  <div>
                    <strong>Spoken:</strong>{" "}
                    "{button.spokenText || "N/A"}"
                  </div>
                  <div>
                    <strong>Action Type:</strong>{" "}
                    {button.action?.type || "none"}
                  </div>
                  {button.action?.type === "link" && (
                    <div className="text-blue-600">
                      <strong>Jumps to page:</strong>{" "}
                      {(() => {
                        const target = active.pages.find(
                          (p: any) => p.id === button.action.toPageId
                        );
                        return target?.name || button.action.toPageId;
                      })()}
                    </div>
                  )}
                  {button.action?.type === "youtube" && (
                    <div className="text-green-600">
                      <div>
                        <strong>Video ID:</strong>{" "}
                        {button.action.videoId}
                      </div>
                      <div>
                        <strong>Title:</strong>{" "}
                        {button.action.title}
                      </div>
                    </div>
                  )}
                  {button.action?.type === "speak" && (
                    <div>
                      <strong>Speak Text:</strong>{" "}
                      "{button.action.text}"
                    </div>
                  )}

                  <div className="mt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => applyButtonAction(button.id)}
                    >
                      Run action
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
