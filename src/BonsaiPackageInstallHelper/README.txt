║ The Bonsai Package Install Helper                                                   2025/05/11 ║
╚════════════════════════════════════════════════════════════════════════════════════════════════╝

  _-_-                              ,,                 |\
    /,                              ||                  \\          _     _
    || __    _-_  ,._-_  _-_        ||/|,  _-_         / \\ ,._-_  < \,  / \\  /'\\ \\/\\  _-_,
   ~||-  -  || \\  ||   || \\       || || || \\       || ||  ||    /-|| || || || || || || ||_.
    ||===|| ||/    ||   ||/         || |' ||/         || ||  ||   (( || || || || || || ||  ~ ||
   ( \_, |  \\,/   \\,  \\,/        \\/   \\,/         \\/   \\,   \/\\ \\_-| \\,/  \\ \\ ,-_-
         `                                                               /  \
                                                                        '----`
╔════════════════════════════════════════════════════════════════════════════════════════════════╗
║ You might think a tiny 100 line C# tool innocuously named the Bonsai Package Install Helper    ║
║ is a fun little application for you to explore while you take a break from reading all that    ║
║ TypeScript (eww.)                                                                              ║
║                                                                                                ║
║ Well I'm sorry to say you won't find your oasis here. This tool is a horrible hack born from   ║
║ the knowledge of good and evil...mostly evil. Bonsai has a pretty open API surface, but one    ║
║ aspect of Bonsai is deliberately pretty closed-off and that's the package management. This is  ║
║ decidedly not super ideal when you're trying to make a CI tool to help people inject packages  ║
║ into their CI instead of relying on --lib.                                                     ║
║                                                                                                ║
║ What you're about to see (unless you make the wise decision to turn back) is the culmination   ║
║ of me being extremely short on sleep and not remembering way too far down my rabbit hole that  ║
║ Bonsai is in fact not an inferred indirect dependencies package manager like modern NuGet and  ║
║ most other package managers are. Basically because Bonsai.config is a lock file, Bonsai        ║
║ typically has no real reason to try and discover dependencies of packages present in it...that ║
║ is unless some external tool (which doesn't know how to discover the dependencies) added some  ║
║ stuff on its own...                                                                            ║
║                                                                                                ║
║ Basically this tool violates Bonsai's API contract as violently as possible in order to        ║
║ instruct the package manager to look up dependencies when it's restoring packages that are     ║
║ missing from the local Packages directory. (Which is why this only works back to Bonsai 2.6.2) ║
║                                                                                                ║
║ It's not actually *that* egregious--the Bonsai internals very naturally support this operation ║
║ --it's just not the most robust way to interact with another piece of software.                ║
║                                                                                                ║
║ Realistically this tool is just a stopgap to hold us over until we can ship a proper CLI       ║
║ interface for manipulating Bonsai's package listing. I made this mostly because it didn't take ║
║ me very long and I figure it allows setup-bonsai to be used for older releases.                ║
║                                                                                                ║
║  The stunts demonstrated within this folder should be performed by trained professionals only  ║
╚════════════════════════════════════════════════════════════════════════════════════════════════╝